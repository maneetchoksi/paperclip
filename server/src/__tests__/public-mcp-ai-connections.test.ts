import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { type Request } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, authUsers, companies, companyMemberships, connectionGrants, principalPermissionGrants, toolApplications, toolConnections } from "@paperclipai/db";
import { aiConnectionBindingSchema } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createPublicMcpOAuth } from "../services/public-mcp/oauth.js";
import { createMcpApiDispatch, createPublicMcpExecutor } from "../services/public-mcp/capabilities.js";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`AI connection MCP checks unavailable: ${support.reason}`);

const config = { origin: "https://paperclip.example", resource: "https://paperclip.example/mcp/paperclip" };
const redirectUri = "https://client.example/callback";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe.skipIf(!support.supported)("public MCP AI connection tools", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let oauth: ReturnType<typeof createPublicMcpOAuth>;
  let execute: ReturnType<typeof createPublicMcpExecutor>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    temp = await startEmbeddedPostgresTestDatabase("paperclip-public-mcp-ai-");
    db = createDb(temp.connectionString);
    oauth = createPublicMcpOAuth(db, config);
    await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true });
    // The AI connection routes and the connection PATCH route that renames them,
    // dispatched exactly as a real assistant call would be.
    const api = express.Router();
    api.use(boardMutationGuard());
    api.use(aiConnectionRoutes(db));
    api.use(toolAccessRoutes(db));
    execute = createPublicMcpExecutor(db, oauth, createMcpApiDispatch(api));
  }, 90000);
  afterAll(async () => { await temp?.cleanup(); vi.unstubAllEnvs(); });

  async function person(companyId: string, role = "member") {
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Human", email: userId + "@example.com", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: role, status: "active" });
    return userId;
  }

  async function company() {
    const [row] = await db.insert(companies).values({ name: "Team", issuePrefix: "M" + randomBytes(4).toString("hex") }).returning();
    return row!;
  }

  /** An assistant connection holding exactly the scopes its person consented to. */
  async function fixture(companyId: string, role = "member", configure = true) {
    const userId = await person(companyId, role);
    const actor: Request["actor"] = { type: "board", source: "session", userId };
    const client = await oauth.register({ client_name: "Test client", redirect_uris: [redirectUri] }, randomUUID());
    const url = await oauth.authorize({ client_id: client.client_id, redirect_uri: redirectUri, resource: config.resource, scope: "paperclip:read paperclip:write paperclip:configure offline_access", state: "state", response_type: "code", code_challenge: challenge, code_challenge_method: "S256" });
    const consent = await oauth.consent(url.split("/").at(-1)!, actor, { decision: "approve", companyId, allowWrites: role !== "viewer", allowConfiguration: configure });
    const tokens = await oauth.token({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: redirectUri, resource: config.resource, code: new URL(consent.redirectUrl).searchParams.get("code")!, code_verifier: verifier });
    const call = (name: string, args: Record<string, unknown> = {}) => execute(tokens.access_token, name, { companyId, ...args });
    return { userId, call };
  }

  /** Mirrors the rows `aiConnectionService.save` writes for an api_key connection. */
  async function connect(companyId: string, ownerUserId: string, name: string, ownership: "personal" | "shared" = "personal") {
    await db.insert(toolApplications).values({ companyId, applicationKey: "app-gallery:anthropic", name: "Claude", type: "mcp_http", metadata: { sourceTemplateKey: "anthropic" }, ownerUserId }).onConflictDoNothing();
    const [application] = await db.select().from(toolApplications).where(and(eq(toolApplications.companyId, companyId), eq(toolApplications.applicationKey, "app-gallery:anthropic")));
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name, uid: `ai-${randomUUID()}`, connectionPurpose: "ai", transport: "runtime_auth",
      authKind: "api_key", credentialPolicy: ownership === "personal" ? "per_user" : "shared",
      status: "active", enabled: true, healthStatus: "ok", createdByUserId: ownerUserId,
      config: { sourceTemplateKey: "anthropic", ai: { provider: "anthropic", method: "api_key" } },
    }).returning();
    const [grant] = await db.insert(connectionGrants).values({
      companyId, connectionId: connection!.id, kind: ownership === "personal" ? "user" : "organization",
      ...(ownership === "personal" ? { subjectUserId: ownerUserId } : {}),
      // A regular member already sees this account label in Paperclip. The tool must not return it.
      providerTenant: { name: "account-owner@example.com" },
    }).returning();
    return { connection: connection!, grant: grant! };
  }

  /** A non-AI connection in the same company, to prove the rename tool refuses it. */
  async function connectTool(companyId: string, ownerUserId: string, name: string) {
    await db.insert(toolApplications).values({ companyId, applicationKey: "app-gallery:linear", name: "Linear", type: "rest_api", ownerUserId }).onConflictDoNothing();
    const [application] = await db.select().from(toolApplications).where(and(eq(toolApplications.companyId, companyId), eq(toolApplications.applicationKey, "app-gallery:linear")));
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name, uid: `tool-${randomUUID()}`, connectionPurpose: "tool", transport: "rest_api",
      status: "active", enabled: true, healthStatus: "ok", createdByUserId: ownerUserId, config: {},
    }).returning();
    return connection!;
  }

  it("lists usable AI connections with the exact runtimeConfig.aiConnection binding and no secrets", async () => {
    const team = await company();
    const f = await fixture(team.id);
    const personal = await connect(team.id, f.userId, "My Claude key");
    const shared = await connect(team.id, f.userId, "Team Claude key", "shared");
    await connect(team.id, await person(team.id), "Colleague private key");
    const result = await f.call("paperclip_list_ai_connections") as { canManageConnections: boolean; connections: Array<Record<string, unknown>> };
    // A member cannot attach a company-shared connection to an agent, and is told so.
    expect(result.canManageConnections).toBe(false);
    // Another person's personal connection stays invisible to this connection.
    expect(result.connections.map((row) => row.name)).not.toContain("Colleague private key");
    expect(result.connections.sort((left, right) => String(left.name).localeCompare(String(right.name)))).toEqual([
      {
        id: personal.connection.id, grantId: personal.grant.id, name: "My Claude key", provider: "anthropic", method: "api_key",
        ownership: "personal", status: "connected", isDefault: false,
        aiConnection: { provider: "anthropic", method: "api_key", mode: "delegated", connectionId: personal.connection.id, grantId: personal.grant.id },
      },
      {
        id: shared.connection.id, grantId: shared.grant.id, name: "Team Claude key", provider: "anthropic", method: "api_key",
        ownership: "shared", status: "connected", isDefault: false,
        aiConnection: { provider: "anthropic", method: "api_key", mode: "shared", connectionId: shared.connection.id, grantId: shared.grant.id },
      },
    ]);
    // No credential, tenant identity, application or raw connection internals cross the boundary.
    const serialized = JSON.stringify(result);
    for (const forbidden of ["@example.com", "account-owner", "credential", "tenant", "applicationKey", "sourceTemplateKey", "transport"]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Every emitted binding is a valid runtimeConfig.aiConnection for create/update agent.
    for (const row of result.connections) expect(aiConnectionBindingSchema.safeParse(row.aiConnection).success).toBe(true);
  });

  it("renames a connection as its creator and replays the same requestId", async () => {
    const team = await company();
    const f = await fixture(team.id);
    const { connection } = await connect(team.id, f.userId, "Claude key");
    const result = await f.call("paperclip_rename_ai_connection", { connectionId: connection.id, name: "  Shared team key  ", requestId: randomUUID() });
    expect(result).toEqual({ connection: { id: connection.id, companyId: team.id, name: "Shared team key", connectionPurpose: "ai", status: "active", enabled: true, updatedAt: expect.any(String) } });
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id)))[0]!.name).toBe("Shared team key");
    expect(JSON.stringify(result)).not.toContain("credential");
    // The receipt replays the first result instead of renaming again on retry.
    const requestId = randomUUID();
    const first = await f.call("paperclip_rename_ai_connection", { connectionId: connection.id, name: "First name", requestId });
    await db.update(toolConnections).set({ name: "Changed outside the tool" }).where(eq(toolConnections.id, connection.id));
    expect(await f.call("paperclip_rename_ai_connection", { connectionId: connection.id, name: "First name", requestId })).toEqual(first);
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id)))[0]!.name).toBe("Changed outside the tool");
    // A retry with different arguments is refused rather than silently applied.
    await expect(f.call("paperclip_rename_ai_connection", { connectionId: connection.id, name: "Other name", requestId })).rejects.toThrow(/requestId/);
  });

  it("lets a connection manager rename a connection someone else created", async () => {
    const team = await company();
    const owner = await person(team.id);
    const { connection } = await connect(team.id, owner, "Owner key");
    const manager = await fixture(team.id);
    expect(await manager.call("paperclip_rename_ai_connection", { connectionId: connection.id, name: "Hijacked key", requestId: randomUUID() }))
      .toMatchObject({ outcome: "rejected", status: 403 });
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id)))[0]!.name).toBe("Owner key");
    await db.insert(principalPermissionGrants).values({ companyId: team.id, principalType: "user", principalId: manager.userId, permissionKey: "tools:manage_connections" });
    expect(await manager.call("paperclip_rename_ai_connection", { connectionId: connection.id, name: "Managed key", requestId: randomUUID() }))
      .toMatchObject({ connection: { name: "Managed key" } });
  });

  it("refuses to rename a connection that is not an AI connection", async () => {
    const team = await company();
    const f = await fixture(team.id);
    const tool = await connectTool(team.id, f.userId, "Linear");
    expect(await f.call("paperclip_rename_ai_connection", { connectionId: tool.id, name: "Renamed file store", requestId: randomUUID() }))
      .toMatchObject({ outcome: "rejected", status: 404 });
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, tool.id)))[0]!.name).toBe("Linear");
  });

  it("rejects renaming without configuration consent, across companies and outside the name bounds", async () => {
    const team = await company();
    const other = await company();
    const f = await fixture(team.id);
    const { connection } = await connect(team.id, f.userId, "Claude key");
    const readOnly = await fixture(team.id, "member", false);
    await expect(readOnly.call("paperclip_rename_ai_connection", { connectionId: connection.id, name: "Renamed key", requestId: randomUUID() }))
      .rejects.toThrow(/paperclip:configure/);
    const viewer = await fixture(team.id, "viewer", false);
    await expect(viewer.call("paperclip_rename_ai_connection", { connectionId: connection.id, name: "Renamed key", requestId: randomUUID() }))
      .rejects.toThrow(/paperclip:configure/);
    const foreign = await connect(other.id, await person(other.id), "Foreign key");
    expect(await f.call("paperclip_rename_ai_connection", { connectionId: foreign.connection.id, name: "Stolen key", requestId: randomUUID() }))
      .toMatchObject({ outcome: "rejected", status: 404 });
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, foreign.connection.id)))[0]!.name).toBe("Foreign key");
    for (const name of ["   ", "x".repeat(161)]) {
      await expect(f.call("paperclip_rename_ai_connection", { connectionId: connection.id, name, requestId: randomUUID() })).rejects.toThrow();
    }
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id)))[0]!.name).toBe("Claude key");
  });
});
