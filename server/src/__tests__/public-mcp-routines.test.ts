import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { type Request } from "express";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb, issues, routines as routinesTable,
  routineRuns, routineTriggers as routineTriggersTable,
} from "@paperclipai/db";
import { activityRoutes } from "../routes/activity.js";
import { routineRoutes } from "../routes/routines.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { createPublicMcpOAuth } from "../services/public-mcp/oauth.js";
import { createMcpApiDispatch, createPublicMcpExecutor, publicMcpCapabilities } from "../services/public-mcp/capabilities.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import * as assignmentWakeups from "../services/issue-assignment-wakeup.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Routine MCP database checks unavailable: ${support.reason}`);
const config = { origin: "https://paperclip.example", resource: "https://paperclip.example/mcp/paperclip" };
const redirectUri = "https://client.example/callback";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const routineToolNames = [
  "paperclip_list_routines", "paperclip_get_routine", "paperclip_create_routine", "paperclip_update_routine",
  "paperclip_add_routine_trigger", "paperclip_update_routine_trigger", "paperclip_delete_routine_trigger", "paperclip_run_routine",
];

describe("routine MCP capability registration", () => {
  const registered = new Map(publicMcpCapabilities.map((capability) => [capability.name, capability]));
  const scopeOf = (name: string) => {
    const capability = registered.get(name);
    if (!capability) return "missing";
    return capability.configure ? "paperclip:configure" : capability.write ? "paperclip:write" : "paperclip:read";
  };

  it("registers the routine tools with the scope each one needs", () => {
    expect([...registered.keys()]).toEqual(expect.arrayContaining(routineToolNames));
    expect(routineToolNames.filter((name) => registered.has(name))).toHaveLength(routineToolNames.length);
    for (const name of ["paperclip_list_routines", "paperclip_get_routine"]) expect(scopeOf(name)).toBe("paperclip:read");
    for (const name of ["paperclip_run_routine"]) expect(scopeOf(name)).toBe("paperclip:write");
    for (const name of ["paperclip_create_routine", "paperclip_update_routine", "paperclip_add_routine_trigger", "paperclip_update_routine_trigger", "paperclip_delete_routine_trigger"]) {
      expect(scopeOf(name)).toBe("paperclip:configure");
    }
  });

  it("accepts only schedule-shaped trigger fields and schema-clean routine fields", () => {
    const scheduleTrigger = (registered.get("paperclip_add_routine_trigger")!.schema.shape as Record<string, { shape?: Record<string, unknown> }>).trigger.shape!;
    expect(Object.keys(scheduleTrigger).sort()).toEqual(["cronExpression", "enabled", "label", "timezone"]);
    const createRoutine = (registered.get("paperclip_create_routine")!.schema.shape as Record<string, { shape?: Record<string, unknown> }>).routine.shape!;
    expect(Object.keys(createRoutine)).not.toEqual(expect.arrayContaining(["env"]));
    // Webhook signing and public fire-URL fields are not assistant input.
    for (const shape of [scheduleTrigger, (registered.get("paperclip_update_routine_trigger")!.schema.shape as Record<string, { shape?: Record<string, unknown> }>).changes.shape!]) {
      expect(Object.keys(shape)).not.toEqual(expect.arrayContaining(["kind", "setupPending", "signingMode", "replayWindowSec", "archived"]));
    }
  });
});

describe.skipIf(!support.supported)("routine assistant tools", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let oauth: ReturnType<typeof createPublicMcpOAuth>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    // A routine webhook trigger makes the detail route resolve its public fire URL.
    vi.stubEnv("PAPERCLIP_API_URL", "https://paperclip.example");
    temp = await startEmbeddedPostgresTestDatabase("paperclip-mcp-routines-");
    db = createDb(temp.connectionString);
    oauth = createPublicMcpOAuth(db, config);
    await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true });
  }, 90000);
  afterAll(async () => { await temp?.cleanup(); vi.unstubAllEnvs(); });

  async function fixture(role = "member", write = true, configure = true) {
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Human", email: userId + "@example.com", createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Team", issuePrefix: "M" + randomBytes(4).toString("hex") }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, membershipRole: role, status: "active" });
    const actor: Request["actor"] = { type: "board", source: "session", userId };
    const client = await oauth.register({ client_name: "Routine client", redirect_uris: [redirectUri] }, randomUUID());
    const url = await oauth.authorize({ client_id: client.client_id, redirect_uri: redirectUri, resource: config.resource, scope: "paperclip:read paperclip:write paperclip:configure offline_access", state: "state", response_type: "code", code_challenge: challenge, code_challenge_method: "S256" });
    const consent = await oauth.consent(url.split("/").at(-1)!, actor, { decision: "approve", companyId: company!.id, allowWrites: write, allowConfiguration: configure });
    const code = new URL(consent.redirectUrl).searchParams.get("code")!;
    const tokens = await oauth.token({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: redirectUri, resource: config.resource, code, code_verifier: verifier });
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Writer", role: "writer", adapterType: "process", status: "idle" }).returning();
    const api = express.Router(); api.use(boardMutationGuard());
    api.use(routineRoutes(db)); api.use(activityRoutes(db));
    const execute = createPublicMcpExecutor(db, oauth, createMcpApiDispatch(api));
    const call = (name: string, a: Record<string, unknown> = {}) => execute(tokens.access_token, name, { companyId: company!.id, ...a });
    return { company: company!, agent: agent!, actor, tokens, call };
  }

  async function createRoutine(f: Awaited<ReturnType<typeof fixture>>, title = "Weekly digest") {
    const created = await f.call("paperclip_create_routine", { requestId: randomUUID(), routine: { title, description: "Compile the weekly digest for the team", assigneeAgentId: f.agent.id } });
    return created.routine as { id: string; status: string; latestRevisionId: string };
  }

  it("creates a routine, attaches a cron schedule, then reads, lists, pauses and edits it", async () => {
    const f = await fixture();
    const routine = await createRoutine(f);
    expect(routine.status).toBe("active");
    const [stored] = await db.select().from(routinesTable).where(eq(routinesTable.id, routine.id));
    expect(stored?.companyId).toBe(f.company.id);
    expect(stored?.assigneeAgentId).toBe(f.agent.id);

    const added = await f.call("paperclip_add_routine_trigger", {
      routineId: routine.id, requestId: randomUUID(),
      trigger: { cronExpression: "0 9 * * 1", timezone: "Europe/Berlin", label: "Monday morning" },
    });
    const trigger = added.trigger as { id: string; kind: string; cronExpression: string; timezone: string; enabled: boolean; nextRunAt: string | null };
    expect(trigger).toMatchObject({ kind: "schedule", cronExpression: "0 9 * * 1", timezone: "Europe/Berlin", enabled: true, label: "Monday morning" });
    expect(trigger.nextRunAt).toBeTruthy();
    const [storedTrigger] = await db.select().from(routineTriggersTable).where(eq(routineTriggersTable.id, trigger.id));
    expect(storedTrigger?.routineId).toBe(routine.id);

    const detail = await f.call("paperclip_get_routine", { routineId: routine.id });
    expect(detail.routine).toMatchObject({ id: routine.id, title: "Weekly digest", assigneeAgentId: f.agent.id, status: "active" });
    expect((detail.routine as { triggers: unknown[] }).triggers).toHaveLength(1);
    expect((detail.routine as { url: string }).url).toContain("/routines/" + routine.id);

    const listed = await f.call("paperclip_list_routines", {});
    expect(listed.routines).toHaveLength(1);
    expect((listed.routines as { id: string }[])[0]).toMatchObject({ id: routine.id, title: "Weekly digest" });
    expect((listed.routines as { triggers: { id: string }[] }[])[0]!.triggers[0]).toMatchObject({ id: trigger.id });

    const paused = await f.call("paperclip_update_routine", { routineId: routine.id, requestId: randomUUID(), changes: { status: "paused" } });
    expect(paused.routine).toMatchObject({ id: routine.id, status: "paused" });
    expect((await db.select().from(routinesTable).where(eq(routinesTable.id, routine.id)))[0]?.status).toBe("paused");
    // A revision from before the pause is stale and must not overwrite the newer routine.
    const stale = await f.call("paperclip_update_routine", { routineId: routine.id, requestId: randomUUID(), changes: { title: "Stale title", baseRevisionId: routine.latestRevisionId } });
    expect(stale).toMatchObject({ outcome: "rejected", status: 409 });
    expect((await db.select().from(routinesTable).where(eq(routinesTable.id, routine.id)))[0]?.title).toBe("Weekly digest");

    const edited = await f.call("paperclip_update_routine_trigger", { routineId: routine.id, triggerId: trigger.id, requestId: randomUUID(), changes: { cronExpression: "30 8 * * 2", enabled: false } });
    expect(edited.trigger).toMatchObject({ id: trigger.id, cronExpression: "30 8 * * 2", enabled: false });

    const removed = await f.call("paperclip_delete_routine_trigger", { routineId: routine.id, triggerId: trigger.id, requestId: randomUUID() });
    expect(removed).toMatchObject({ deleted: true, routineId: routine.id, triggerId: trigger.id });
    expect(await db.select().from(routineTriggersTable).where(eq(routineTriggersTable.id, trigger.id))).toHaveLength(0);
    expect(((await f.call("paperclip_get_routine", { routineId: routine.id })).routine as { triggers: unknown[] }).triggers).toHaveLength(0);
  });

  it("runs a routine now and links the dispatched task", async () => {
    const wake = vi.spyOn(assignmentWakeups, "queueIssueAssignmentWakeup").mockResolvedValue(null);
    try {
      const f = await fixture();
      const routine = await createRoutine(f, "Daily triage");
      const started = await f.call("paperclip_run_routine", { routineId: routine.id, requestId: randomUUID() });
      const run = started.run as { id: string; source: string; status: string; linkedIssueId: string };
      expect(run).toMatchObject({ routineId: routine.id, source: "manual", status: "issue_created" });
      expect(run.linkedIssueId).toBeTruthy();
      expect(started.scheduling).toContain("does not guarantee the agent run has begun");
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake.mock.calls[0]?.[0]).toMatchObject({ reason: "issue_assigned", contextSource: "routine.dispatch" });
      const [dispatched] = await db.select().from(issues).where(eq(issues.id, run.linkedIssueId));
      expect(dispatched).toMatchObject({ companyId: f.company.id, title: "Daily triage", assigneeAgentId: f.agent.id, status: "todo" });
      expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine.id))).toHaveLength(1);
      // The same requestId replays the recorded receipt instead of dispatching a second run.
      expect(await f.call("paperclip_get_routine", { routineId: routine.id }).then((v) => (v.routine as { recentRuns: unknown[] }).recentRuns)).toHaveLength(1);
      expect(wake).toHaveBeenCalledTimes(1);
    } finally { wake.mockRestore(); }
  });

  it("refuses routine configuration without paperclip:configure", async () => {
    const f = await fixture("member", true, false);
    await expect(f.call("paperclip_create_routine", { requestId: randomUUID(), routine: { title: "Unauthorized", assigneeAgentId: f.agent.id } })).rejects.toThrow("paperclip:configure");
    await expect(f.call("paperclip_add_routine_trigger", { routineId: randomUUID(), requestId: randomUUID(), trigger: { cronExpression: "0 9 * * 1" } })).rejects.toThrow("paperclip:configure");
    await expect(f.call("paperclip_update_routine", { routineId: randomUUID(), requestId: randomUUID(), changes: { status: "paused" } })).rejects.toThrow("paperclip:configure");
    expect(await db.select().from(routinesTable).where(eq(routinesTable.companyId, f.company.id))).toHaveLength(0);
  });

  it("rejects triggers that belong to another company", async () => {
    const f = await fixture();
    const other = await fixture();
    const routine = await createRoutine(f);
    const foreignRoutine = await createRoutine(other, "Other company digest");
    const foreign = await other.call("paperclip_add_routine_trigger", { routineId: foreignRoutine.id, requestId: randomUUID(), trigger: { cronExpression: "0 9 * * 1" } });
    const foreignTriggerId = (foreign.trigger as { id: string }).id;

    // A trigger id is only meaningful through a routine in the authorized company.
    expect(await f.call("paperclip_update_routine_trigger", { routineId: foreignRoutine.id, triggerId: foreignTriggerId, requestId: randomUUID(), changes: { enabled: false } })).toMatchObject({ outcome: "rejected", status: 404 });
    expect(await f.call("paperclip_delete_routine_trigger", { routineId: routine.id, triggerId: foreignTriggerId, requestId: randomUUID() })).toMatchObject({ outcome: "rejected", status: 404 });
    expect(await f.call("paperclip_get_routine", { routineId: foreignRoutine.id }).catch((error: { status?: number }) => error.status)).toBe(404);
    expect((await db.select().from(routineTriggersTable).where(eq(routineTriggersTable.id, foreignTriggerId)))[0]?.enabled).toBe(true);
    expect((await db.select().from(routineTriggersTable).where(eq(routineTriggersTable.routineId, routine.id)))).toHaveLength(0);
  }, 60000);

  it("keeps integration-only webhook triggers out of the schedule tools and out of output", async () => {
    const f = await fixture();
    const routine = await createRoutine(f);
    const added = await f.call("paperclip_add_routine_trigger", { routineId: routine.id, requestId: randomUUID(), trigger: { cronExpression: "15 6 * * *" } });
    const publicId = randomBytes(12).toString("hex");
    const [webhook] = await db.insert(routineTriggersTable).values({
      companyId: f.company.id, routineId: routine.id, kind: "webhook", publicId, signingMode: "app_webhook", replayWindowSec: 300,
    }).returning();

    // Only schedule triggers are assistant-manageable, so an external integration is never rewritten or removed.
    expect(await f.call("paperclip_update_routine_trigger", { routineId: routine.id, triggerId: webhook!.id, requestId: randomUUID(), changes: { enabled: false } })).toMatchObject({ outcome: "rejected", status: 422 });
    expect(await f.call("paperclip_delete_routine_trigger", { routineId: routine.id, triggerId: webhook!.id, requestId: randomUUID() })).toMatchObject({ outcome: "rejected", status: 422 });
    expect((await db.select().from(routineTriggersTable).where(eq(routineTriggersTable.id, webhook!.id)))[0]?.enabled).toBe(true);

    const detail = await f.call("paperclip_get_routine", { routineId: routine.id });
    const detailTriggers = (detail.routine as { triggers: { id: string; kind: string; cronExpression: string }[] }).triggers;
    expect(detailTriggers.map((candidate) => candidate.id)).toEqual([(added.trigger as { id: string }).id]);
    expect(detailTriggers[0]).toMatchObject({ kind: "schedule", cronExpression: "15 6 * * *" });
    for (const response of [added, detail, await f.call("paperclip_list_routines", {})]) {
      const text = JSON.stringify(response);
      for (const forbidden of ["publicId", "secretId", "signingMode", "replayWindowSec", "webhookUrl", "\"env\""]) expect(text).not.toContain(forbidden);
      expect(text).not.toContain(publicId);
      expect(text).not.toContain(webhook!.id);
    }
    expect((await f.call("paperclip_list_routines", {})).routines).toHaveLength(1);
  }, 60000);
});
