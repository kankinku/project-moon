import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "../config.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "../tool-metadata.js";
import { MergeAuditProxyClient, mapDeveloperRepoPathToAuditor } from "./merge-audit-proxy-client.js";

function proxyArgs(repoPath: string, rest: Record<string, unknown>): Record<string, unknown> {
  return {
    ...rest,
    repoPath: mapDeveloperRepoPathToAuditor(repoPath),
  };
}

export function registerMergeAuditProxyTools(
  server: McpServer,
  config: AppConfig,
  proxy: MergeAuditProxyClient,
): void {
  const authMetadata = toolAuthMetadata(config);
  const repoPath = z.string().min(1).describe(
    "Developer-runtime repository path under /shared. Moon maps it to the auditor's read-only workspace.",
  );
  const runId = z.string().min(1).describe("Merge audit run ID returned by merge_audit_start.");
  const repository = z.string().regex(/^[^/\s]+\/[^/\s]+$/).describe(
    "GitHub repository in owner/name form.",
  );
  const pullNumber = z.number().int().positive().describe("GitHub pull request number.");

  server.registerTool(
    "merge_audit_start",
    {
      title: "Start independent merge audit",
      description:
        "Route a SHA-pinned independent audit to the isolated merge-auditor runtime and secondary GitHub identity.",
      inputSchema: {
        repoPath,
        baseBranch: z.string().default("main").describe("Target branch or commitish used for the proposed merge."),
        headBranch: z.string().min(1).describe("Feature branch whose current commit will be pinned for this audit."),
        request: z.string().optional().describe("Original user request or acceptance criteria."),
        internalAuditSummary: z.string().optional().describe(
          "Optional developer-side review evidence. The independent auditor must verify it rather than trust it.",
        ),
      },
      annotations: TOOL_ANNOTATIONS.additiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, baseBranch, headBranch, request, internalAuditSummary }) =>
      proxy.callTool("merge_audit_start", proxyArgs(repoPath, {
        baseBranch,
        headBranch,
        request,
        internalAuditSummary,
      })),
  );

  server.registerTool(
    "merge_audit_context",
    {
      title: "Get independent merge audit context",
      description:
        "Read the isolated auditor's pinned diff, changed files, evidence, and SHA staleness state without modifying source.",
      inputSchema: { repoPath, runId },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId }) =>
      proxy.callTool("merge_audit_context", proxyArgs(repoPath, { runId })),
  );

  server.registerTool(
    "merge_audit_decide",
    {
      title: "Record independent merge decision",
      description:
        "Record the isolated auditor's SHA-bound MERGE_APPROVED, CHANGES_REQUIRED, or BLOCKED decision.",
      inputSchema: {
        repoPath,
        runId,
        decision: z.enum(["MERGE_APPROVED", "CHANGES_REQUIRED", "BLOCKED"]).describe(
          "Independent merge decision.",
        ),
        rationale: z.string().min(1).describe("Concrete evidence and reasoning for the independent decision."),
        unresolvedP1: z.number().int().min(0).default(0).describe(
          "Number of unresolved blocking P1 findings.",
        ),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, decision, rationale, unresolvedP1 }) =>
      proxy.callTool("merge_audit_decide", proxyArgs(repoPath, {
        runId,
        decision,
        rationale,
        unresolvedP1,
      })),
  );

  server.registerTool(
    "merge_audit_status",
    {
      title: "Inspect independent merge audit status",
      description:
        "Read the isolated auditor's pinned/current SHA state, decision, staleness, and merge readiness.",
      inputSchema: { repoPath, runId },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId }) =>
      proxy.callTool("merge_audit_status", proxyArgs(repoPath, { runId })),
  );

  server.registerTool(
    "merge_audit_publish",
    {
      title: "Publish independent merge audit review",
      description:
        "Publish the SHA-bound independent review to GitHub through the isolated auditor account after live PR-head verification.",
      inputSchema: { repoPath, runId, repository, pullNumber },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, repository, pullNumber }) =>
      proxy.callTool("merge_audit_publish", proxyArgs(repoPath, {
        runId,
        repository,
        pullNumber,
      })),
  );

  server.registerTool(
    "merge_audit_merge",
    {
      title: "Merge independently approved pull request",
      description:
        "Ask the isolated auditor account to merge only when the audited SHA is still current, the independent approval is valid, required CI checks passed, and GitHub reports the PR mergeable.",
      inputSchema: { repoPath, runId, repository, pullNumber },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, repository, pullNumber }) =>
      proxy.callTool("merge_audit_merge", proxyArgs(repoPath, {
        runId,
        repository,
        pullNumber,
      })),
  );
}
