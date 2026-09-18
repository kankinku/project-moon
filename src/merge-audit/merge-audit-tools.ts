import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "../config.js";
import type { GitHubCliMergeAuditPublisher } from "../github/github-cli-merge-audit-publisher.js";
import type { GitHubCliMergeExecutor } from "../github/github-cli-merge-executor.js";
import { runTool } from "../tool-result.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "../tool-metadata.js";
import { MergeAuditService } from "./merge-audit-service.js";
import type { MergeAuditDecision } from "./merge-audit-types.js";

function parseDecision(value: unknown): MergeAuditDecision {
  if (value === "MERGE_APPROVED" || value === "CHANGES_REQUIRED" || value === "BLOCKED") {
    return value;
  }
  throw new Error("Merge audit decision has not been recorded");
}

export function registerMergeAuditTools(
  server: McpServer,
  config: AppConfig,
  audits: MergeAuditService,
  publisher?: GitHubCliMergeAuditPublisher,
  executor?: GitHubCliMergeExecutor,
): void {
  const authMetadata = toolAuthMetadata(config);
  const repoPath = z.string().min(1).describe("Path inside the Git repository to audit.");
  const runId = z.string().min(1).describe("Merge audit run ID returned by merge_audit_start.");

  server.registerTool(
    "merge_audit_start",
    {
      title: "Start independent merge audit",
      description:
        "Start a fresh merge audit pinned to immutable base/head/merge-base commits. Internal review output may be supplied as evidence but is never treated as approval.",
      inputSchema: {
        repoPath,
        baseBranch: z.string().default("main").describe("Target branch or commitish used for the proposed merge."),
        headBranch: z.string().min(1).describe("Feature branch whose current commit will be pinned for this audit."),
        request: z.string().optional().describe("Original user request or acceptance criteria."),
        internalAuditSummary: z.string().optional().describe("Optional internal-audit evidence. The merge auditor must independently verify it."),
      },
      annotations: TOOL_ANNOTATIONS.additiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, baseBranch, headBranch, request, internalAuditSummary }) =>
      runTool(() => audits.start({ repoPath, baseBranch, headBranch, request, internalAuditSummary })),
  );

  server.registerTool(
    "merge_audit_context",
    {
      title: "Get independent merge audit context",
      description:
        "Return the pinned final diff, changed files, request, internal-audit evidence, and SHA staleness state for an independent merge decision. This tool never modifies source code.",
      inputSchema: { repoPath, runId },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId }) => runTool(() => audits.context({ repoPath, runId })),
  );

  server.registerTool(
    "merge_audit_decide",
    {
      title: "Record independent merge decision",
      description:
        "Record MERGE_APPROVED, CHANGES_REQUIRED, or BLOCKED with a concrete rationale. Approval is bound to the pinned head SHA and is rejected when the branch has moved or blocking P1 findings remain.",
      inputSchema: {
        repoPath,
        runId,
        decision: z.enum(["MERGE_APPROVED", "CHANGES_REQUIRED", "BLOCKED"]),
        rationale: z.string().min(1).describe("Human-readable evidence and reasoning for the merge decision."),
        unresolvedP1: z.number().int().min(0).default(0),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, decision, rationale, unresolvedP1 }) =>
      runTool(() => audits.decide({ repoPath, runId, decision, rationale, unresolvedP1 })),
  );

  server.registerTool(
    "merge_audit_status",
    {
      title: "Inspect independent merge audit status",
      description:
        "Return pinned/current SHA state, decision, approval SHA, staleness, unresolved P1 count, and whether the exact current head is ready for the external merge gate.",
      inputSchema: { repoPath, runId },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId }) => runTool(() => audits.status({ repoPath, runId })),
  );

  if (publisher) {
    server.registerTool(
      "merge_audit_publish",
      {
        title: "Publish independent merge audit review",
        description:
          "Re-check local staleness and the live GitHub PR head, verify the dedicated gh CLI account is not the PR author, then publish APPROVE or REQUEST_CHANGES with the SHA-bound audit rationale. No source modification or push command is exposed.",
        inputSchema: {
          repoPath,
          runId,
          repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/).describe("GitHub repository in owner/name form."),
          pullNumber: z.number().int().positive().describe("Pull request number to receive the independent review."),
        },
        annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
        _meta: authMetadata,
      },
      async ({ repoPath, runId, repository, pullNumber }) =>
        runTool(async () => {
          const status = await audits.status({ repoPath, runId });
          if (status.stale === true) {
            throw new Error("Merge audit is STALE and cannot be published. Start a fresh audit for the current head SHA.");
          }
          const decision = parseDecision(status.decision);
          const rationale = typeof status.rationale === "string" ? status.rationale.trim() : "";
          const headSha = typeof status.headSha === "string" ? status.headSha : "";
          const unresolvedP1 =
            typeof status.unresolvedP1 === "number" && Number.isInteger(status.unresolvedP1)
              ? status.unresolvedP1
              : 0;
          if (!rationale) throw new Error("Merge audit rationale is missing");
          if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error("Merge audit pinned head SHA is invalid");
          if (decision === "MERGE_APPROVED" && status.readyToMerge !== true) {
            throw new Error("MERGE_APPROVED is not ready to publish because the approval SHA no longer matches the current head");
          }
          return publisher.publish({
            repository,
            pullNumber,
            runId,
            headSha,
            decision,
            rationale,
            unresolvedP1,
          });
        }),
    );
  }

  if (executor) {
    server.registerTool(
      "merge_audit_merge",
      {
        title: "Merge independently approved pull request",
        description:
          "Merge the pull request through the isolated auditor account only when the SHA-bound audit is still current and GitHub confirms the auditor approval, CI checks, and merge gate are satisfied.",
        inputSchema: {
          repoPath,
          runId,
          repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/).describe("GitHub repository in owner/name form."),
          pullNumber: z.number().int().positive().describe("Pull request number to merge."),
        },
        annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
        _meta: authMetadata,
      },
      async ({ repoPath, runId, repository, pullNumber }) =>
        runTool(async () => {
          const status = await audits.status({ repoPath, runId });
          if (status.stale === true || status.readyToMerge !== true) {
            throw new Error("Merge audit is not ready for merge or has become STALE");
          }
          const decision = parseDecision(status.decision);
          if (decision !== "MERGE_APPROVED") {
            throw new Error(`Merge audit decision is not MERGE_APPROVED: ${decision}`);
          }
          const headSha = typeof status.headSha === "string" ? status.headSha : "";
          if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error("Merge audit pinned head SHA is invalid");
          return executor.execute({ repository, pullNumber, headSha });
        }),
    );
  }
}
