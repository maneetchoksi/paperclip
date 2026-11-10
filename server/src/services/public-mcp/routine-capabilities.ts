import { z } from "zod";
import { createRoutineSchema, runRoutineSchema, updateRoutineSchema, updateRoutineTriggerSchema } from "@paperclipai/shared";
import { McpApiError, company, requestId, boundedLimit, pathId, object, pick, rows, type ApiDispatch, type Capability } from "./contracts.js";
import type { McpPrincipal } from "./oauth.js";

const routine = { ...company, routineId: z.uuid().describe("The exact routine UUID returned by paperclip_list_routines. List routines first; never derive a UUID from a title.") };
const routineTrigger = { ...routine, triggerId: z.uuid().describe("The exact trigger UUID listed under triggers by paperclip_get_routine. Never guess a trigger ID.") };

// Routine `env` bindings name company secrets, so they are never assistant-readable or writable.
// Creating and updating a routine are separate schemas so the create defaults stay route-shaped.
const newRoutine = createRoutineSchema.pick({
  title: true, description: true, assigneeAgentId: true, projectId: true, priority: true,
  status: true, concurrencyPolicy: true, catchUpPolicy: true, variables: true,
}).strict();
const routineChanges = updateRoutineSchema.pick({
  title: true, description: true, assigneeAgentId: true, projectId: true, priority: true,
  status: true, concurrencyPolicy: true, catchUpPolicy: true, variables: true, baseRevisionId: true,
}).strict().refine((value) => Object.keys(value).length > 0, "Supply at least one change");
// Scheduled triggers only: webhook and API triggers carry a public fire URL or signing secret.
const newScheduleTrigger = updateRoutineTriggerSchema.pick({ label: true, enabled: true, cronExpression: true, timezone: true }).extend({
  cronExpression: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(100).optional(),
}).strict();
const triggerChanges = updateRoutineTriggerSchema.pick({ label: true, enabled: true, cronExpression: true, timezone: true }).extend({
  cronExpression: z.string().trim().min(1).max(200).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Supply at least one change");
const runOptions = runRoutineSchema.pick({ triggerId: true, variables: true });

const routineFields = [
  "id", "companyId", "projectId", "goalId", "parentIssueId", "title", "description", "assigneeAgentId", "priority", "status",
  "concurrencyPolicy", "catchUpPolicy", "activityGatePolicy", "activityGateScope", "variables",
  "latestRevisionId", "latestRevisionNumber", "lastTriggeredAt", "lastEnqueuedAt", "createdAt", "updatedAt",
];
// publicId, secretId, signingMode, replayWindowSec and webhookUrl never cross the assistant boundary.
const triggerFields = ["id", "routineId", "kind", "label", "enabled", "cronExpression", "timezone", "nextRunAt", "lastFiredAt", "lastResult", "createdAt", "updatedAt"];
// triggerPayload may carry caller-supplied data from other integrations, so it is not echoed back.
const runFields = ["id", "routineId", "triggerId", "source", "status", "triggeredAt", "linkedIssueId", "coalescedIntoRunId", "failureReason", "completedAt", "createdAt"];
const issueFields = ["id", "identifier", "title", "status"];

const scheduleTriggers = (value: unknown) => rows(value).map(object).filter((trigger) => trigger.kind === "schedule").map((trigger) => pick(trigger, triggerFields));
const runOutput = (value: unknown) => {
  const run = object(value);
  return { ...pick(run, runFields), linkedIssue: run.linkedIssue ? pick(run.linkedIssue, issueFields) : null };
};
const routineOutput = (value: unknown) => {
  const owner = object(value);
  return {
    ...pick(owner, routineFields),
    project: owner.project ? pick(owner.project, ["id", "name", "status"]) : null,
    assignee: owner.assignee ? pick(owner.assignee, ["id", "name", "role", "title"]) : null,
    triggers: scheduleTriggers(owner.triggers),
    recentRuns: rows(owner.recentRuns).map(runOutput),
    lastRun: owner.lastRun ? runOutput(owner.lastRun) : null,
    activeIssue: owner.activeIssue ? pick(owner.activeIssue, issueFields) : null,
  };
};
const routineUrl = (p: McpPrincipal, id: unknown, origin: string) => origin + "/" + pathId(p.company.issuePrefix) + "/routines/" + pathId(id);
const issueUrl = (p: McpPrincipal, id: unknown, origin: string) => origin + "/" + pathId(p.company.issuePrefix) + "/issues/" + pathId(id);
const scheduleCron = (timezone: unknown) => typeof timezone === "string" && timezone ? timezone : "UTC";
/** The internal dispatch forwards the method straight to the REST router, which serves
 * DELETE /routine-triggers/:id; only the shared ApiDispatch method union omits DELETE. */
const dispatchDelete = (api: ApiDispatch, p: McpPrincipal, path: string) =>
  (api as unknown as (principal: McpPrincipal, method: "DELETE", path: string) => Promise<unknown>)(p, "DELETE", path);

/** Trigger routes take only a trigger id, so resolve ownership through its routine first. */
async function ownedScheduleTrigger(p: McpPrincipal, a: Record<string, unknown>, api: ApiDispatch) {
  const detail = object(await api(p, "GET", `/routines/${pathId(a.routineId)}`));
  const trigger = rows(detail.triggers).map(object).find((candidate) => candidate.id === a.triggerId);
  if (!trigger) throw new McpApiError(404);
  // Removing or rewriting a webhook trigger would silently break an external integration.
  if (trigger.kind !== "schedule") throw new McpApiError(422, { code: "MCP_ROUTINE_TRIGGER_NOT_SCHEDULE" });
  return trigger;
}

export const routineMcpCapabilities: Capability[] = [
  {
    name: "paperclip_list_routines", description: "List the authorized company's recurring work with its schedule details and most recent run. Read a routine with paperclip_get_routine before changing it.",
    schema: z.object({ ...company, projectId: z.uuid().optional().describe("Only routines attached to this project."), limit: boundedLimit }).strict(),
    run: async (p, a, api, origin) => {
      const all = rows(await api(p, "GET", `/companies/${pathId(a.companyId)}/routines${a.projectId ? `?projectId=${pathId(a.projectId)}` : ""}`));
      const limit = Number(a.limit);
      return { routines: all.slice(0, limit).map((v) => ({ ...routineOutput(v), url: routineUrl(p, object(v).id, origin) })), count: Math.min(all.length, limit), total: all.length };
    },
  },
  {
    name: "paperclip_get_routine", description: "Read one routine with its schedule triggers, recent runs and any run currently in progress.",
    schema: z.object(routine).strict(),
    run: async (p, a, api, origin) => ({ routine: { ...routineOutput(await api(p, "GET", `/routines/${pathId(a.routineId)}`)), url: routineUrl(p, a.routineId, origin) } }),
  },
  {
    name: "paperclip_create_routine", configure: true,
    description: "Create recurring work assigned to a Paperclip agent, then attach a schedule with paperclip_add_routine_trigger. Requires configuration consent and the tasks:assign permission. An active routine dispatches autonomous runs on its schedule and spends configured model budget.",
    schema: z.object({ ...company, requestId, routine: newRoutine }).strict(),
    run: async (p, a, api, origin) => {
      const created = await api(p, "POST", `/companies/${pathId(a.companyId)}/routines`, object(a.routine));
      return { routine: { ...routineOutput(created), url: routineUrl(p, object(created).id, origin) },
        scheduling: "A routine without an enabled schedule trigger never runs on its own. Add one with paperclip_add_routine_trigger." };
    },
  },
  {
    name: "paperclip_update_routine", configure: true, destructive: true,
    description: "Change a routine's title, description, assigned agent, project, priority, concurrency or status, including pausing (status paused) and resuming (status active). Requires configuration consent. Supply baseRevisionId from paperclip_get_routine so a routine changed in Paperclip meanwhile is not overwritten. This does not edit triggers; use the trigger tools.",
    schema: z.object({ ...routine, requestId, changes: routineChanges }).strict(),
    run: async (p, a, api, origin) => ({ routine: { ...routineOutput(await api(p, "PATCH", `/routines/${pathId(a.routineId)}`, object(a.changes))), url: routineUrl(p, a.routineId, origin) } }),
  },
  {
    name: "paperclip_add_routine_trigger", configure: true,
    description: "Add a cron schedule trigger to a routine so it runs on a recurring cadence in the given timezone. Requires configuration consent. Webhook and API triggers must be configured in Paperclip.",
    schema: z.object({ ...routine, requestId, trigger: newScheduleTrigger }).strict(),
    run: async (p, a, api) => {
      const requested = object(a.trigger);
      const created = object(await api(p, "POST", `/routines/${pathId(a.routineId)}/triggers`, {
        kind: "schedule", cronExpression: requested.cronExpression, timezone: scheduleCron(requested.timezone),
        ...(requested.label === undefined ? {} : { label: requested.label }),
        ...(requested.enabled === undefined ? {} : { enabled: requested.enabled }),
      }));
      return { trigger: pick(created.trigger, triggerFields), nextRunAt: object(created.trigger).nextRunAt ?? null };
    },
  },
  {
    name: "paperclip_update_routine_trigger", configure: true, destructive: true,
    description: "Change or enable/disable one of a routine's cron schedule triggers. Requires configuration consent. A disabled trigger stops future automatic runs without deleting its schedule.",
    schema: z.object({ ...routineTrigger, requestId, changes: triggerChanges }).strict(),
    run: async (p, a, api) => {
      await ownedScheduleTrigger(p, a, api);
      return { trigger: pick(await api(p, "PATCH", `/routine-triggers/${pathId(a.triggerId)}`, object(a.changes)), triggerFields) };
    },
  },
  {
    name: "paperclip_delete_routine_trigger", configure: true, destructive: true,
    description: "Permanently delete one of a routine's cron schedule triggers so the routine stops running on that cadence. Requires configuration consent. To pause only temporarily, disable the trigger with paperclip_update_routine_trigger instead.",
    schema: z.object({ ...routineTrigger, requestId }).strict(),
    run: async (p, a, api) => {
      await ownedScheduleTrigger(p, a, api);
      await dispatchDelete(api, p, `/routine-triggers/${pathId(a.triggerId)}`);
      return { deleted: true, routineId: a.routineId, triggerId: a.triggerId };
    },
  },
  {
    name: "paperclip_run_routine", write: true,
    description: "Start one run of a routine now as the connected person. This creates a task assigned to the routine's agent, may schedule autonomous execution and consumes configured model budget. Ordinary permissions, agent availability, concurrency policy and approvals still apply. Read the run later with paperclip_get_routine.",
    schema: z.object({ ...routine, requestId, ...runOptions.shape }).strict(),
    run: async (p, a, api, origin) => {
      const run = await api(p, "POST", `/routines/${pathId(a.routineId)}/run`, {
        source: "manual",
        ...(a.triggerId ? { triggerId: a.triggerId } : {}),
        ...(a.variables ? { variables: a.variables } : {}),
      });
      const linkedIssueId = object(run).linkedIssueId;
      return { run: runOutput(run), issueUrl: typeof linkedIssueId === "string" ? issueUrl(p, linkedIssueId, origin) : null,
        scheduling: "Submitted to normal Paperclip scheduling. A start does not guarantee the agent run has begun." };
    },
  },
];
