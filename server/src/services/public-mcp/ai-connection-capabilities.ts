import { z } from "zod";
import { company, object, pathId, pick, requestId, rows, type Capability } from "./contracts.js";

/** Fields a regular company member already sees in the AI connections list. Never
 * account labels, credential references, tenant ids or provider tokens. */
const connectionFields = ["id", "grantId", "name", "provider", "method", "ownership", "status", "isDefault", "unavailableReason"];
/** The connection PATCH response only needs identity and lifecycle state back. */
const renamedFields = ["id", "companyId", "name", "connectionPurpose", "status", "enabled", "updatedAt"];

/** The exact runtimeConfig.aiConnection binding for this connection. Personal
 * connections are bound as `delegated`; company-shared ones as `shared`. */
function aiConnectionBinding(connection: Record<string, unknown>) {
  return {
    provider: connection.provider ?? null,
    method: connection.method ?? null,
    mode: connection.ownership === "personal" ? "delegated" : "shared",
    connectionId: connection.id ?? null,
    grantId: connection.grantId ?? null,
  };
}

/** Assistant tools for the organization's AI connections. Filled in by the AI-connection package. */
export const aiConnectionMcpCapabilities: Capability[] = [
  {
    name: "paperclip_list_ai_connections",
    description: "List the AI connections this person may use to run agents in the authorized company, with the current sign-in status of each. Copy one connection's aiConnection object verbatim into runtimeConfig.aiConnection of paperclip_create_agent or paperclip_update_agent to make that agent run on it; bind a company-shared connection only when this person may configure connections. Credentials are never returned; sign-in is managed in Paperclip.",
    schema: z.object(company).strict(),
    run: async (p, a, api) => {
      const result = object(await api(p, "GET", `/companies/${pathId(a.companyId)}/ai-connections`));
      return {
        connections: rows(result.connections).map((value) => {
          const connection = object(value);
          return { ...pick(connection, connectionFields), aiConnection: aiConnectionBinding(connection) };
        }),
      };
    },
  },
  {
    name: "paperclip_rename_ai_connection", configure: true, destructive: true,
    description: "Rename one AI connection in the authorized company as the connected person, so people can tell connections apart when choosing where an agent runs. Only the connection's creator or a connection manager can rename it. This changes the display name only: sign-in, provider, ownership and running agents keep using the same connection.",
    schema: z.object({
      ...company,
      connectionId: z.uuid().describe("The id of an AI connection returned by paperclip_list_ai_connections."),
      name: z.string().trim().min(1).max(160).describe("The exact display name people should see for this connection."),
      requestId,
    }).strict(),
    run: async (p, a, api) => ({
      connection: pick(await api(p, "PATCH", `/tool-connections/${pathId(a.connectionId)}`, { name: a.name }), renamedFields),
    }),
  },
];
