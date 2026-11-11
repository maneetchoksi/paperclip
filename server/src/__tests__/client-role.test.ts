import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { assertCompanyAccess } from "../routes/authz.js";
import { authorizationService } from "../services/authorization.js";
import {
  grantsForHumanRole,
  isClientHumanRole,
  isCommentOnlyHumanRole,
  normalizeHumanRole,
  resolveHumanInviteRole,
} from "../services/company-member-roles.js";
import { humanJoinGrantsFromDefaults } from "../services/invite-grants.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function makeReq(input: {
  method?: string;
  url?: string;
  membershipRole?: string | null;
}) {
  return {
    method: input.method ?? "GET",
    originalUrl: input.url,
    actor: {
      type: "board",
      userId: "client-user",
      source: "session",
      companyIds: ["company-1"],
      memberships: [
        {
          companyId: "company-1",
          membershipRole: input.membershipRole ?? "client",
          status: "active",
        },
      ],
    },
  } as unknown as Express.Request;
}

describe("client role grants", () => {
  it("keeps the client role to tools:use and nothing else", () => {
    expect(grantsForHumanRole("client")).toEqual([
      { permissionKey: "tools:use", scope: null },
    ]);
  });

  it("recognises the role on invite defaults and joins", () => {
    expect(normalizeHumanRole("client")).toBe("client");
    expect(resolveHumanInviteRole({ human: { role: "client" } })).toBe("client");
    expect(humanJoinGrantsFromDefaults({ human: { role: "client" } }, "client")).toEqual([
      { permissionKey: "tools:use", scope: null },
    ]);
  });

  it("never reports client grants for agent configuration, environments or invites", () => {
    const granted = grantsForHumanRole("client").map((grant) => grant.permissionKey);
    for (const forbidden of [
      "agents:create",
      "agents:configure",
      "skills:create",
      "environments:manage",
      "users:invite",
      "users:manage_permissions",
      "joins:approve",
      "tools:admin",
      "tools:manage_connections",
      "tools:manage_runtime",
      "audit:view_agent_actions",
      "tasks:assign",
      "pipelines:write",
    ]) {
      expect(granted).not.toContain(forbidden);
    }
  });

  it("treats client and viewer as comment-only roles", () => {
    expect(isClientHumanRole("client")).toBe(true);
    expect(isClientHumanRole("operator")).toBe(false);
    expect(isCommentOnlyHumanRole("client")).toBe(true);
    expect(isCommentOnlyHumanRole("viewer")).toBe(true);
    expect(isCommentOnlyHumanRole("operator")).toBe(false);
  });
});

describe("client write gate", () => {
  it("lets a client read", () => {
    expect(() => assertCompanyAccess(makeReq({ method: "GET", url: "/api/issues/issue-1" }), "company-1"))
      .not.toThrow();
  });

  it("lets a client comment and open or message a chat", () => {
    for (const [method, url] of [
      ["POST", "/api/issues/issue-1/comments"],
      ["POST", "/api/companies/company-1/chats/lead"],
      ["POST", "/api/companies/company-1/issues/issue-1/attachments"],
      ["POST", "/api/issues/issue-1/read"],
      ["DELETE", "/api/issues/issue-1/read"],
    ] as const) {
      expect(() => assertCompanyAccess(makeReq({ method, url }), "company-1"))
        .not.toThrow();
    }
  });

  it("refuses every other write", () => {
    const cases: Array<[string, string]> = [
      ["PATCH", "/api/companies/company-1"],
      ["POST", "/api/companies/company-1/invites"],
      ["PATCH", "/api/agents/agent-1"],
      ["POST", "/api/agents/agent-1/wakeup"],
      ["POST", "/api/companies/company-1/issues"],
      ["DELETE", "/api/issues/issue-1"],
      ["POST", "/api/companies/company-1/tool-connections"],
      ["POST", "/api/companies/company-1/tools/connections"],
      ["POST", "/api/companies/company-1/secrets"],
      ["POST", "/api/companies/company-1/routines"],
      ["POST", "/api/issues/issue-1/comments/comment-1/reactions"],
    ];
    for (const [method, url] of cases) {
      expect(() => assertCompanyAccess(makeReq({ method, url }), "company-1"))
        .toThrow("Client access is limited to comments and chat");
    }
  });

  it("still refuses viewer writes with the viewer message", () => {
    expect(() =>
      assertCompanyAccess(
        makeReq({ method: "POST", url: "/api/issues/issue-1/comments", membershipRole: "viewer" }),
        "company-1",
      )
    ).toThrow("Viewer access is read-only");
  });
});

async function createCompany(db: ReturnType<typeof createDb>, label: string) {
  return db
    .insert(companies)
    .values({
      name: `Client role ${label} ${randomUUID()}`,
      issuePrefix: `CL${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: ReturnType<typeof createDb>, companyId: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      reportsTo: null,
      permissions: {},
      adapterType: "process",
      adapterConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createClientMembership(
  db: ReturnType<typeof createDb>,
  companyId: string,
) {
  const userId = `user-${randomUUID()}`;
  await db.insert(authUsers).values({
    id: userId,
    name: `Client ${userId}`,
    email: `${userId}@example.com`,
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "client",
  });
  for (const grant of grantsForHumanRole("client")) {
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: userId,
      permissionKey: grant.permissionKey,
      scope: grant.scope,
      grantedByUserId: null,
    });
  }
  return userId;
}

describeEmbeddedPostgres("client role authorization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-client-role-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reads and comments but cannot mutate tasks", async () => {
    const company = await createCompany(db, "Comment");
    const userId = await createClientMembership(db, company.id);
    const agent = await createAgent(db, company.id);
    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Chat with the lead",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agent.id,
      })
      .returning()
      .then((rows) => rows[0]!);

    const authorization = authorizationService(db);
    const actor = { type: "board" as const, userId, source: "session" as const };
    const resource = {
      type: "issue" as const,
      companyId: company.id,
      issueId: issue.id,
      projectId: issue.projectId,
      parentIssueId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      status: issue.status,
    };

    await expect(authorization.decide({ actor, action: "issue:read", resource }))
      .resolves.toMatchObject({ allowed: true });
    await expect(authorization.decide({ actor, action: "issue:comment", resource }))
      .resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({ actor, action: "issue:mutate", resource }))
      .resolves.toMatchObject({ allowed: false, reason: "deny_missing_grant" });
  });

  it("cannot operate runs, wake agents, read secrets or assign tasks", async () => {
    const company = await createCompany(db, "Operations");
    const userId = await createClientMembership(db, company.id);
    const agent = await createAgent(db, company.id);

    const authorization = authorizationService(db);
    const actor = { type: "board" as const, userId, source: "session" as const };
    const companyResource = { type: "company" as const, companyId: company.id };
    const agentResource = { type: "agent" as const, companyId: company.id, agentId: agent.id };

    await expect(authorization.decide({ actor, action: "agent:read", resource: agentResource }))
      .resolves.toMatchObject({ allowed: true });
    await expect(authorization.decide({ actor, action: "company_scope:read", resource: companyResource }))
      .resolves.toMatchObject({ allowed: true });

    for (const [action, resource] of [
      ["agent:wake", agentResource],
      ["runtime:manage", companyResource],
      ["secrets:read", companyResource],
      ["secrets:propose", companyResource],
      ["decision_queue:manage", companyResource],
      ["decision_triage:manage", companyResource],
    ] as const) {
      await expect(authorization.decide({ actor, action, resource }))
        .resolves.toMatchObject({ allowed: false, reason: "deny_missing_grant" });
    }

    await expect(
      authorization.decide({
        actor: { ...actor, companyIds: [company.id] },
        action: "tasks:assign",
        resource: { type: "issue", companyId: company.id, assigneeAgentId: agent.id },
        scope: { assigneeAgentId: agent.id },
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("is refused on agent configuration, environments, invites and tool administration", async () => {
    const company = await createCompany(db, "Grants");
    const userId = await createClientMembership(db, company.id);
    const agent = await createAgent(db, company.id);

    const authorization = authorizationService(db);
    const actor = { type: "board" as const, userId, source: "session" as const };

    for (const [action, resource] of [
      ["agents:configure", { type: "agent", companyId: company.id, agentId: agent.id }],
      ["agents:create", { type: "company", companyId: company.id }],
      ["environments:manage", { type: "company", companyId: company.id }],
      ["users:invite", { type: "company", companyId: company.id }],
      ["users:manage_permissions", { type: "company", companyId: company.id }],
      ["tools:admin", { type: "company", companyId: company.id }],
      ["audit:view_agent_actions", { type: "company", companyId: company.id }],
    ] as const) {
      await expect(authorization.decide({ actor, action, resource }))
        .resolves.toMatchObject({ allowed: false, reason: "deny_missing_grant" });
    }
  });

  it("keeps a role re-seed from widening the client grant set", async () => {
    const company = await createCompany(db, "Reseed");
    const userId = await createClientMembership(db, company.id);

    const grants = await db
      .select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, userId));

    expect(grants.map((grant) => grant.permissionKey)).toEqual(["tools:use"]);
  });
});
