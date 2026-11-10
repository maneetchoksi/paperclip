import { z } from "zod";
import { applyMcpReasoningEffort, mcpAgentModelConfig, MCP_AGENT_HARNESSES } from "./agent-config.js";
import {
  createAgentHireSchema, updateIssueSchema, upsertIssueDocumentSchema, updateAgentSchema, upsertAgentInstructionsFileSchema,
  aiRuntimeConnectionBindingSchema, createProjectSchema, updateProjectSchema,
  companySkillCreateSchema, companySkillUpdateSchema, companySkillFileUpdateSchema,
  createIssueWorkProductSchema, updateIssueWorkProductSchema,
} from "@paperclipai/shared";
import { McpApiError, company, task, requestId, pathId, object, pick, rows, taskFields, documentFields, type ApiDispatch, type Capability } from "./contracts.js";
import type { McpPrincipal } from "./oauth.js";

const agent = { ...company, agentId: z.uuid() };
const project = { ...company, projectId: z.uuid() };
const skill = { ...company, skillId: z.uuid() };
const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);
const filePath = z.string().min(1).max(512).refine(v => !v.startsWith("/") && !v.includes("\\") && v.split("/").every(p => p !== ".." && p !== "." && p !== ""), "Use a relative file path without traversal");
const taskChanges = updateIssueSchema.pick({ title: true, description: true, assigneeAgentId: true, assigneeUserId: true, projectId: true, parentId: true, blockedByIssueIds: true, unblockDescriptor: true, status: true, priority: true }).extend({
  title: z.string().trim().min(1).max(240).optional(), description: z.string().max(524288).nullable().optional(),
  assigneeAgentId: z.uuid().nullable().optional(), blockedByIssueIds: z.array(z.uuid()).max(100).optional(),
}).strict();
// Skill selections are omitted: PATCH /agents/:id does not apply them. Use paperclip_set_agent_skills.
const mcpHarness = z.enum([...MCP_AGENT_HARNESSES]);
const agentChanges = updateAgentSchema.pick({ name: true, role: true, title: true, icon: true, reportsTo: true, capabilities: true, budgetMonthlyCents: true }).extend({
  // "off" is Pi's lowest thinking level; codex_local and claude_local still reject the levels
  // their own model lists do not support through applyMcpReasoningEffort.
  adapterConfig: z.object({ model: z.string().trim().min(1).max(256).optional(), reasoningEffort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional() }).strict().optional(),
  adapterType: mcpHarness.optional().describe("Harness that executes the agent: codex_local, claude_local or pi_local. Switching also requires adapterConfig.model in the same call."),
  runtimeConfig: z.object({ aiConnection: aiRuntimeConnectionBindingSchema }).strict().optional(),
}).strict();
// Hires are limited to managed local harnesses configured only by model and effort:
// a board actor is not subject to the agent-key host-command guards, so commands,
// env, cwd and process/http adapters must never be reachable from an assistant.
const agentHire = createAgentHireSchema.pick({ role: true, title: true, icon: true, reportsTo: true, capabilities: true, budgetMonthlyCents: true }).extend({
  name: z.string().trim().min(1).max(200),
  desiredSkills: z.array(z.string().trim().min(1).max(300)).max(100).optional().describe("Skill keys or slugs from paperclip_list_skills or paperclip_import_skills."),
  adapterType: mcpHarness.describe("Agent harness: codex_local, claude_local or pi_local (Pi). Use the adapterType of an existing agent from paperclip_get_agent when unsure."),
  adapterConfig: agentChanges.shape.adapterConfig,
  runtimeConfig: agentChanges.shape.runtimeConfig,
}).strict();
const projectFields = { name: true, description: true, status: true, leadAgentId: true, goalIds: true, targetDate: true, color: true, icon: true } as const;
const skillMetadata = companySkillUpdateSchema.unwrap().pick({ description: true, iconUrl: true, color: true, tagline: true, authorName: true, homepageUrl: true, categories: true }).strict();
const deliverableFields = { type: true, provider: true, externalId: true, title: true, url: true, status: true, isPrimary: true, summary: true } as const;
// Approval decisions are not exposed by changing a work product's review state/status.
const deliverableStatus = z.enum(["active", "ready_for_review", "closed", "failed", "archived", "draft"]);
const agentFields = ["id", "companyId", "name", "role", "title", "icon", "status", "reportsTo", "capabilities", "budgetMonthlyCents", "adapterType"];
const projectOutputFields = ["id", "companyId", "name", "description", "status", "leadAgentId", "goalIds", "targetDate", "color", "icon", "repositories"];
const workFields = ["id", "issueId", "type", "provider", "externalId", "title", "url", "status", "isPrimary", "summary", "metadata", "updatedAt"];
// Only sources that resolve to public github.com repositories. Local paths would read the
// server's filesystem and other hosts would make Paperclip fetch arbitrary URLs.
const gitHubName = "[A-Za-z0-9][A-Za-z0-9_.-]*";
const skillSource = z.string().trim().max(2048).regex(
  new RegExp(`^(?:https://(?:www\\.)?(?:github\\.com|skills\\.sh)/${gitHubName}/${gitHubName}(?:/[^\\s?#]*)?|${gitHubName}/${gitHubName}(?:/${gitHubName})?)$`, "i"),
  "Use a https://github.com repository, folder or SKILL.md URL, a https://skills.sh URL, or owner/repo[/skill]",
).describe("A GitHub repository, folder or SKILL.md URL such as https://github.com/owner/repo/tree/main/skills/name, a https://skills.sh/owner/repo/skill URL, or owner/repo[/skill].");
const skillSelection = z.array(z.string().trim().min(1).max(300)).max(100);
const skillFields = ["id", "companyId", "name", "slug", "key", "description", "markdown", "versionId", "currentVersionId", "latestVersionId", "categories", "tagline", "iconUrl", "color", "authorName", "homepageUrl", "sharingScope", "updatedAt"];
const importedSkillFields = ["id", "name", "slug", "key", "description", "sourceType", "sourceLocator", "currentVersionId", "categories"];
/** Skill keys assigned to the agent (adapterConfig.paperclipSkillSync), without other adapter settings. */
function desiredSkillKeys(config: Record<string, unknown>) {
  return rows(object(config.paperclipSkillSync).desiredSkills).flatMap(v => {
    const key = typeof v === "string" ? v : object(v).key;
    return typeof key === "string" && key ? [key] : [];
  });
}
/**
 * Build the PATCH for an assistant-selected harness switch.
 *
 * A switch replaces the adapter that executes the agent, so an assistant may only move between
 * the managed local harnesses, only with an explicit model, and never away from an adapter
 * whose configuration could carry host commands (process, http, gateway).
 *
 * PATCH /agents/:id keeps the adapter-agnostic keys (env, cwd, instructions, skills) from the
 * previous adapter, exactly like a harness switch made in the Paperclip UI: agents can hold
 * tokens and working directories they still need afterwards. That is safe on this boundary
 * because the assistant schema cannot set env, cwd or commands at all, so model and effort are
 * the only values the assistant chooses here.
 */
async function harnessSwitch(p: McpPrincipal, agentId: unknown, changes: Record<string, unknown>, api: ApiDispatch) {
  const current = object(await api(p, "GET", `/agents/${pathId(agentId)}/configuration`));
  const currentType = String(current.adapterType ?? "");
  if (String(changes.adapterType) === currentType) return changes;
  if (!(MCP_AGENT_HARNESSES as readonly string[]).includes(currentType)) {
    throw new McpApiError(422, { code: "MCP_HARNESS_SWITCH_UNSUPPORTED", currentAdapterType: currentType });
  }
  const requested = object(changes.adapterConfig);
  const model = typeof requested.model === "string" ? requested.model.trim() : "";
  if (!model) throw new McpApiError(422, { code: "MCP_HARNESS_SWITCH_MODEL_REQUIRED", adapterType: String(changes.adapterType) });
  return { ...changes, adapterConfig: { ...requested, model } };
}
function agentOutput(value: unknown) {
  const v = object(value);
  return { ...pick(v, agentFields), desiredSkills: desiredSkillKeys(object(v.adapterConfig)), adapterConfig: mcpAgentModelConfig(String(v.adapterType), object(v.adapterConfig)), runtimeConfig: pick(v.runtimeConfig, ["aiConnection"]) };
}
function projectOutput(value: unknown) {
  const v = object(value);
  return { ...pick(v, projectOutputFields), repositories: rows(v.workspaces).flatMap(raw => {
    const workspace = object(raw);
    if (typeof workspace.repoUrl !== "string") return [];
    let url: string | null = null;
    try {
      const parsed = new URL(workspace.repoUrl);
      if (["https:", "http:", "ssh:"].includes(parsed.protocol)) {
        parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = "";
        url = parsed.toString();
      }
    } catch { /* Do not disclose opaque legacy remote strings or local paths. */ }
    return [{ id: object(workspace.metadata).githubRepositoryId ?? null, name: workspace.name, url }];
  }) };
}
const skillBase = (a: Record<string, unknown>) => `/companies/${pathId(a.companyId)}/skills`;
const skillPath = (a: Record<string, unknown>) => `${skillBase(a)}/${pathId(a.skillId)}`;
const nonempty = <T extends z.ZodObject>(schema: T) => schema.refine(v => Object.keys(v).length > 0, "Supply at least one change");

export const expandedMcpCapabilities: Capability[] = [
  {
    name: "paperclip_update_task", write: true, destructive: true,
    description: "Edit a task's title, description, priority, project, parent, dependencies, assignment or status as the connected person. Assignment/status changes may schedule agents and spend configured budget. Review decisions must be made in Paperclip. Reuse requestId on retries.",
    schema: z.object({ ...task, requestId, changes: nonempty(taskChanges) }).strict(),
    run: async (p, a, api) => ({ task: pick(await api(p, "PATCH", `/issues/${pathId(a.taskId)}`, a.changes), taskFields) }),
  },
  {
    name: "paperclip_finish_task", write: true, destructive: true,
    description: "Mark a task done as the connected person. This is not an agent run finalization or an approval decision. Review gates and existing execution controls still apply.",
    schema: z.object({ ...task, requestId }).strict(),
    run: async (p, a, api) => ({ task: pick(await api(p, "PATCH", `/issues/${pathId(a.taskId)}`, { status: "done" }), taskFields) }),
  },
  {
    name: "paperclip_block_task", write: true, destructive: true,
    description: "Block a task with an explicit owner and action needed to unblock it. Existing dependency, approval and execution controls apply; this does not impersonate its assigned agent.",
    schema: z.object({ ...task, requestId, unblockDescriptor: taskChanges.shape.unblockDescriptor.unwrap().unwrap() }).strict(),
    run: async (p, a, api) => ({ task: pick(await api(p, "PATCH", `/issues/${pathId(a.taskId)}`, { status: "blocked", unblockDescriptor: a.unblockDescriptor }), taskFields) }),
  },
  {
    name: "paperclip_write_document", write: true, destructive: true,
    description: "Create or update a durable Markdown task document. Read it first and supply latestRevisionId as baseRevisionId; use null only for a new document. A stale revision is rejected. For videos or binary files use paperclip_get_upload_url.",
    schema: z.object({ ...task, requestId, key, document: upsertIssueDocumentSchema.extend({ baseRevisionId: z.uuid().nullable() }).strict() }).strict(),
    run: async (p, a, api) => ({ document: pick(await api(p, "PUT", `/issues/${pathId(a.taskId)}/documents/${pathId(a.key)}`, a.document), documentFields) }),
  },
  {
    name: "paperclip_list_document_revisions", description: "Read a task document's revision history before editing or comparing saved results.",
    schema: z.object({ ...task, key }).strict(),
    run: async (p, a, api) => ({ revisions: await api(p, "GET", `/issues/${pathId(a.taskId)}/documents/${pathId(a.key)}/revisions`) }),
  },
  {
    name: "paperclip_register_deliverable", write: true,
    description: "Register a durable task deliverable. An attachmentId registers an uploaded file owned by this task. No external URL is fetched. This cannot approve a deliverable.",
    schema: z.object({ ...task, requestId, deliverable: createIssueWorkProductSchema.pick(deliverableFields).extend({ status: deliverableStatus.default("active") }).strict(), attachmentId: z.uuid().optional() }).strict(),
    run: async (p, a, api) => ({ deliverable: pick(await api(p, "POST", `/issues/${pathId(a.taskId)}/work-products`, await attachmentDeliverable(p, a, api)), workFields) }),
  },
  {
    name: "paperclip_update_deliverable", write: true, destructive: true,
    description: "Update a task deliverable, or replace its attachment reference with a newly uploaded file. Older attachments remain available. This cannot decide a review.",
    schema: z.object({ ...task, requestId, deliverableId: z.uuid(), deliverable: updateIssueWorkProductSchema.pick(deliverableFields).extend({ status: deliverableStatus.optional() }).strict(), attachmentId: z.uuid().optional() }).strict(),
    run: async (p, a, api) => {
      const owned = rows(await api(p, "GET", `/issues/${pathId(a.taskId)}/work-products`));
      if (!owned.some(v => object(v).id === a.deliverableId)) throw new McpApiError(404);
      return { deliverable: pick(await api(p, "PATCH", `/work-products/${pathId(a.deliverableId)}`, await attachmentDeliverable(p, a, api)), workFields) };
    },
  },
  {
    name: "paperclip_get_agent", description: "Get an agent's identity and non-secret operating configuration. Credentials, environment variables and permission policies are not returned.",
    schema: z.object(agent).strict(), run: async (p, a, api) => ({ agent: agentOutput(await api(p, "GET", `/agents/${pathId(a.agentId)}/configuration`)) }),
  },
  {
    name: "paperclip_update_agent", configure: true, destructive: true,
    description: "Update an existing agent's identity, reporting line (reportsTo, which places it in a manager's team), model, reasoning effort, harness (adapterType: codex_local, claude_local or pi_local), budget, or binding to an existing AI connection. Switching harness needs the new model in the same call; the agent's env, working directory, instructions and assigned skills are kept. To change its skills use paperclip_set_agent_skills. Requires configuration consent. Does not change credentials, execution commands or permission policies. New settings affect future execution.",
    schema: z.object({ ...agent, requestId, changes: nonempty(agentChanges) }).strict(), run: async (p, a, api) => {
      const changes = object(a.changes);
      const patch = changes.adapterType === undefined ? changes : await harnessSwitch(p, a.agentId, changes, api);
      return { agent: agentOutput(await api(p, "PATCH", `/agents/${pathId(a.agentId)}`, patch)) };
    },
  },
  {
    name: "paperclip_create_agent", configure: true,
    description: "Hire a new agent with a role, reporting line (reportsTo puts it in a manager's team), skills (keys or slugs from paperclip_list_skills or paperclip_import_skills), model, reasoning effort, harness (adapterType: codex_local, claude_local or pi_local), budget and an existing AI connection. Requires configuration consent and normal agent-creation permission. If the company requires board approval for new agents, this creates a pending hire approval that must be decided in Paperclip before the agent can run. Set instructions afterwards with paperclip_update_agent_instructions.",
    schema: z.object({ ...company, requestId, agent: agentHire }).strict(),
    run: async (p, a, api, origin) => {
      const { adapterConfig: requested = {}, ...hire } = object(a.agent);
      const model = object(requested).model;
      let adapterConfig: Record<string, unknown>;
      try {
        // The hire route stores adapter-native fields; translate the neutral effort like PATCH does.
        adapterConfig = applyMcpReasoningEffort(String(hire.adapterType), model === undefined ? {} : { model }, object(requested));
      } catch {
        throw new McpApiError(422, { code: "MCP_REASONING_EFFORT_UNSUPPORTED" });
      }
      const result = object(await api(p, "POST", `/companies/${pathId(a.companyId)}/agent-hires`, { ...hire, adapterConfig }));
      const approval = result.approval ? object(result.approval) : null;
      return {
        agent: agentOutput(result.agent),
        approval: approval ? { ...pick(approval, ["id", "type", "status"]), url: origin + "/" + pathId(p.company.issuePrefix) + "/approvals/" + pathId(approval.id) } : null,
      };
    },
  },
  {
    name: "paperclip_set_agent_skills", configure: true, destructive: true,
    description: "Assign organization skills to an agent. mode \"add\" or \"remove\" changes only the listed skills; \"replace\" sets the complete list (an empty list removes all). Use keys or slugs from paperclip_list_skills or paperclip_import_skills. Requires configuration consent and permission to update the agent. Takes effect on the agent's next run.",
    schema: z.object({ ...agent, requestId, mode: z.enum(["add", "remove", "replace"]), skills: skillSelection }).strict().refine(v => v.mode === "replace" || v.skills.length > 0, "List at least one skill to add or remove"),
    run: async (p, a, api) => {
      const snapshot = object(await api(p, "POST", `/agents/${pathId(a.agentId)}/skills/sync`, { mode: a.mode, desiredSkills: a.skills }));
      const desired = rows(snapshot.desiredSkills).filter((v): v is string => typeof v === "string");
      return {
        agentId: a.agentId, desiredSkills: desired,
        skills: rows(snapshot.entries).filter(v => desired.includes(String(object(v).key))).map(v => pick(v, ["key", "runtimeName", "state"])),
        warnings: rows(snapshot.warnings),
      };
    },
  },
  {
    name: "paperclip_read_agent_instructions", description: "Read an agent instruction file and its revision/hash. Defaults to AGENTS.md. Use the returned revision/hash when updating.",
    schema: z.object({ ...agent, path: filePath.default("AGENTS.md") }).strict(),
    run: async (p, a, api) => ({ instructions: await api(p, "GET", `/agents/${pathId(a.agentId)}/instructions-bundle/file?path=${pathId(a.path)}`) }),
  },
  {
    name: "paperclip_update_agent_instructions", configure: true, destructive: true,
    description: "Update an existing agent's instruction file. Requires configuration consent and the revision/hash from a prior read; use null for a new file. Managed paths and normal instruction permissions apply. Legacy promptTemplate.legacy.md must be migrated in Paperclip before editing.",
    schema: z.object({ ...agent, requestId, file: upsertAgentInstructionsFileSchema.omit({ clearLegacyPromptTemplate: true }).extend({ path: filePath }).refine(v => v.baseRevisionId !== undefined || v.baseHash !== undefined, "Read the file and provide its baseRevisionId or baseHash") }).strict(),
    run: async (p, a, api) => ({ instructions: await api(p, "PUT", `/agents/${pathId(a.agentId)}/instructions-bundle/file`, a.file) }),
  },
  {
    name: "paperclip_list_agent_instruction_revisions", description: "Read the revision history for an agent's entry instructions.",
    schema: z.object({ ...agent, path: filePath.optional(), cursor: z.uuid().optional() }).strict(),
    run: async (p, a, api) => ({ revisions: await api(p, "GET", `/agents/${pathId(a.agentId)}/instructions-bundle/history?${new URLSearchParams(Object.fromEntries(["path", "cursor"].filter(k => a[k] !== undefined).map(k => [k, String(a[k])])) )}`) }),
  },
  {
    name: "paperclip_get_project", description: "Read a project's settings and repository references.", schema: z.object(project).strict(),
    run: async (p, a, api) => ({ project: projectOutput(await api(p, "GET", `/projects/${pathId(a.projectId)}`)) }),
  },
  {
    name: "paperclip_create_project", configure: true, description: "Create a project, optionally selecting repository IDs from paperclip_list_project_repositories. Requires configuration consent. Does not create remote repositories or configure execution commands.",
    schema: z.object({ ...company, requestId, project: createProjectSchema.pick({ ...projectFields, repositoryIds: true }).strict() }).strict(),
    run: async (p, a, api) => ({ project: projectOutput(await api(p, "POST", `/companies/${pathId(a.companyId)}/projects`, { ...object(a.project), idempotencyKey: `mcp:${p.grant.userId}:${a.requestId}` })) }),
  },
  {
    name: "paperclip_update_project", configure: true, destructive: true, description: "Update a project's name, description, status, lead, goals, target date, icon or color. Requires configuration consent.",
    schema: z.object({ ...project, requestId, changes: nonempty(updateProjectSchema.pick(projectFields).strict()) }).strict(),
    run: async (p, a, api) => ({ project: projectOutput(await api(p, "PATCH", `/projects/${pathId(a.projectId)}`, a.changes)) }),
  },
  {
    name: "paperclip_add_project_agent", configure: true,
    description: "Give an agent access to a private project so it can see and work on that project's tasks. Open projects need no membership. To put an agent to work on a project, also assign it tasks with paperclip_create_task (projectId and assigneeAgentId) or make it the project lead with paperclip_update_project (leadAgentId). Requires configuration consent and permission to manage the project's access.",
    schema: z.object({ ...project, requestId, agentId: z.uuid() }).strict(),
    run: async (p, a, api) => ({ member: pick(await api(p, "POST", `/projects/${pathId(a.projectId)}/access-members`, { subjectType: "agent", subjectId: a.agentId }), ["id", "projectId", "subjectType", "subjectId", "name"]) }),
  },
  {
    name: "paperclip_list_project_repositories", description: "List repository choices available to this person and organization before creating a project or changing its repositories.", schema: z.object(company).strict(),
    run: async (p, a, api) => ({ repositories: await api(p, "GET", `/companies/${pathId(a.companyId)}/project-repositories`) }),
  },
  {
    name: "paperclip_set_project_repositories", configure: true, destructive: true, description: "Replace a project's repository selection with IDs from paperclip_list_project_repositories. Requires configuration consent and normal repository access.",
    schema: z.object({ ...project, requestId, repositoryIds: z.array(z.string().regex(/^\d+$/)).max(100) }).strict(),
    run: async (p, a, api) => ({ project: projectOutput(await api(p, "PUT", `/projects/${pathId(a.projectId)}/repositories`, { repositoryIds: a.repositoryIds })) }),
  },
  {
    name: "paperclip_list_skills", description: "List skills visible in the authorized organization.", schema: z.object(company).strict(),
    run: async (p, a, api) => ({ skills: rows(await api(p, "GET", skillBase(a))).map(v => pick(v, skillFields)) }),
  },
  {
    name: "paperclip_get_skill", description: "Read a skill's metadata and current version before editing.", schema: z.object(skill).strict(),
    run: async (p, a, api) => ({ skill: pick(await api(p, "GET", skillPath(a)), skillFields) }),
  },
  {
    name: "paperclip_import_skills", configure: true,
    description: "Import organization skills from GitHub, like Skills > Import in Paperclip. Accepts a public repository, folder or SKILL.md link, a skills.sh link, or owner/repo[/skill]; a repository link imports every SKILL.md in it. Importing the same repository again refreshes it. Requires configuration consent and normal skill-import policy. Assign the returned keys with paperclip_set_agent_skills.",
    schema: z.object({ ...company, requestId, source: skillSource }).strict(),
    run: async (p, a, api) => {
      const result = object(await api(p, "POST", `${skillBase(a)}/import`, { source: a.source }));
      return { imported: rows(result.imported).map(v => pick(v, importedSkillFields)), warnings: rows(result.warnings) };
    },
  },
  {
    name: "paperclip_create_skill", configure: true, description: "Create an organization skill with Markdown instructions. Requires configuration consent and normal skill policy. Does not enable public sharing.",
    schema: z.object({ ...company, requestId, skill: companySkillCreateSchema.pick({ name: true, slug: true, description: true, markdown: true, folderId: true, categories: true }).strict() }).strict(),
    run: async (p, a, api) => ({ skill: pick(await api(p, "POST", skillBase(a), { ...object(a.skill), idempotencyKey: `mcp:${a.requestId}` }), skillFields) }),
  },
  {
    name: "paperclip_update_skill", configure: true, destructive: true, description: "Update skill metadata. To update instructions or assets use paperclip_write_skill_file. Requires configuration consent; does not change sharing permissions.",
    schema: z.object({ ...skill, requestId, changes: nonempty(skillMetadata) }).strict(),
    run: async (p, a, api) => ({ skill: pick(await api(p, "PATCH", skillPath(a), a.changes), skillFields) }),
  },
  {
    name: "paperclip_read_skill_file", description: "Read a skill file such as SKILL.md. Binary skill assets use the returned encoding; large task files use attachment downloads.",
    schema: z.object({ ...skill, path: filePath.default("SKILL.md") }).strict(),
    run: async (p, a, api) => ({ file: await api(p, "GET", `${skillPath(a)}/files?path=${pathId(a.path)}`) }),
  },
  {
    name: "paperclip_write_skill_file", configure: true, destructive: true, description: "Write skill instructions or a bounded asset using utf8 or base64. Supply expectedVersionId from paperclip_get_skill, null for a new skill version. Normal skill policy and file safety checks apply.",
    schema: z.object({ ...skill, requestId, file: companySkillFileUpdateSchema.omit({ idempotencyKey: true }).extend({ path: filePath, content: z.string().max(524288), expectedVersionId: z.uuid().nullable() }).strict() }).strict(),
    run: async (p, a, api) => ({ file: await api(p, "PATCH", `${skillPath(a)}/files`, { ...object(a.file), idempotencyKey: `mcp:${a.requestId}` }) }),
  },
];

async function attachmentDeliverable(p: Parameters<Capability["run"]>[0], a: Record<string, unknown>, api: Parameters<Capability["run"]>[2]) {
  const result = { ...object(a.deliverable) };
  if (!a.attachmentId) return result;
  const attachment = rows(await api(p, "GET", `/issues/${pathId(a.taskId)}/attachments`)).find(v => object(v).id === a.attachmentId);
  if (!attachment) throw new McpApiError(404);
  const contentPath = `/api/attachments/${a.attachmentId}/content`;
  return { ...result, type: "artifact", provider: "paperclip", externalId: a.attachmentId, metadata: {
    ...pick(attachment, ["contentType", "byteSize", "originalFilename"]), attachmentId: a.attachmentId,
    contentPath, openPath: contentPath, downloadPath: contentPath + "?download=1",
  } };
}
