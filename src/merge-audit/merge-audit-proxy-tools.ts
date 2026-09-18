import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "../config.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "../tool-metadata.js";
import { MergeAuditProxyClient, mapDeveloperRepoPathToAuditor } from "./merge-audit-proxy-client.js";

const category = z.enum([
  "requirements",
  "correctness",
  "code_quality",
  "tests",
  "regression",
  "architecture",
  "api_contracts",
  "security",
  "performance",
  "operations",
  "maintainability",
]);

const finding = z.object({
  id: z.string().min(1).describe("Stable finding identifier unique within this audit."),
  severity: z.enum(["P1", "P2", "P3", "P4"]).describe("P1 is merge-blocking; P2-P4 are non-blocking severities."),
  category: category.describe("Review category affected by the finding."),
  title: z.string().min(1).describe("Concise finding title."),
  evidence: z.string().min(1).describe("Concrete code, behavior, policy, or verification evidence supporting the finding."),
  file: z.string().min(1).optional().describe("Relevant repository-relative file path when applicable."),
  line: z.number().int().positive().optional().describe("Relevant 1-based line number when applicable."),
  recommendation: z.string().min(1).optional().describe("Recommended remediation or follow-up."),
  resolved: z.boolean().describe("Whether the finding is already resolved in the pinned head SHA."),
});

const coverage = z.object({
  category: category.describe("Mandatory full-review category."),
  verdict: z.enum(["PASS", "CONCERN", "NOT_APPLICABLE"]).describe(
    "PASS when verified, CONCERN when material risk remains, or NOT_APPLICABLE with evidence.",
  ),
  evidence: z.string().min(1).describe("Concrete evidence explaining the category verdict."),
});

const validationEvidence = z.object({
  source: z.enum(["moon_task", "moon_review", "github_ci", "external_ci"]).describe(
    "Origin of deterministic validation evidence.",
  ),
  profile: z.string().min(1).describe("Validation profile name, such as fast, normal, or release."),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i).describe("Exact validated 40-character head commit SHA."),
  passed: z.boolean().describe("Whether the referenced validation completed successfully."),
  reference: z.string().min(1).describe("Traceable run ID, check URL/name, or other evidence reference."),
  summary: z.string().min(1).describe("Concise summary of what the validation actually checked."),
});

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
      title: "Start full independent merge audit",
      description:
        "Route a repository/PR/base/head-pinned full final code review to the isolated merge-auditor runtime and secondary GitHub identity.",
      inputSchema: {
        repoPath,
        repository,
        pullNumber,
        baseBranch: z.string().default("main").describe("Target branch used for the proposed merge."),
        headBranch: z.string().min(1).describe("Feature branch whose current commit will be pinned for this audit."),
        request: z.string().optional().describe("Original user request or acceptance criteria."),
        internalAuditSummary: z.string().optional().describe(
          "Optional developer-side review/validation evidence. The independent auditor must verify it rather than trust it.",
        ),
      },
      annotations: TOOL_ANNOTATIONS.additiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, repository, pullNumber, baseBranch, headBranch, request, internalAuditSummary }) =>
      proxy.callTool("merge_audit_start", proxyArgs(repoPath, {
        repository,
        pullNumber,
        baseBranch,
        headBranch,
        request,
        internalAuditSummary,
      })),
  );

  server.registerTool(
    "merge_audit_context",
    {
      title: "Get full independent merge-review context",
      description:
        "Read the isolated auditor's pinned diff, policies, risk, required review categories, validation requirement, and base/head staleness without modifying source.",
      inputSchema: {
        repoPath,
        runId,
        includePaths: z.array(z.string().min(1)).max(12).optional().describe(
          "Repository-relative paths to read from the exact audited head SHA for surrounding-code review.",
        ),
        searchTerms: z.array(z.string().min(1).max(200)).max(8).optional().describe(
          "Literal Git grep terms used to discover callers, consumers, related tests, or architecture references at the exact audited head SHA.",
        ),
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, includePaths, searchTerms }) =>
      proxy.callTool("merge_audit_context", proxyArgs(repoPath, {
        runId,
        includePaths,
        searchTerms,
      })),
  );

  server.registerTool(
    "merge_audit_decide",
    {
      title: "Record full independent merge decision",
      description:
        "Record the isolated auditor's structured full code review, validation evidence, and SHA-bound MERGE_APPROVED, CHANGES_REQUIRED, or BLOCKED decision.",
      inputSchema: {
        repoPath,
        runId,
        decision: z.enum(["MERGE_APPROVED", "CHANGES_REQUIRED", "BLOCKED"]).describe(
          "Independent final merge decision.",
        ),
        rationale: z.string().min(1).describe("Overall evidence-based rationale for the independent decision."),
        findings: z.array(finding).describe("Structured P1-P4 code-review findings."),
        coverage: z.array(coverage).describe("One evidence-backed verdict for every mandatory full-review category."),
        validationEvidence: z.array(validationEvidence).describe(
          "Deterministic validation evidence bound to the audited PR/head SHA and validation profile. Only independently resolved github_ci evidence backed by the unchanged pinned workflow may satisfy the approval gate; moon_task/external_ci/moon_review remain supplemental.",
        ),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, decision, rationale, findings, coverage, validationEvidence }) =>
      proxy.callTool("merge_audit_decide", proxyArgs(repoPath, {
        runId,
        decision,
        rationale,
        findings,
        coverage,
        validationEvidence,
      })),
  );

  server.registerTool(
    "merge_audit_status",
    {
      title: "Inspect full independent merge-audit status",
      description:
        "Read target binding, base/head staleness, structured review state, validation sufficiency, quality gate, and merge readiness.",
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
      title: "Publish independent merge-audit review",
      description:
        "Publish the full SHA-bound review through the isolated auditor account after verifying the audit-bound repository/PR/base/head.",
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
      title: "Merge fully reviewed pull request",
      description:
        "Ask the isolated auditor account to merge only when the full independent quality gate plus live GitHub base/head/review/CI gates all pass.",
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
