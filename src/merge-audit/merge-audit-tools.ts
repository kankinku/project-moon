import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "../config.js";
import type { GitHubCliMergeAuditPublisher } from "../github/github-cli-merge-audit-publisher.js";
import type { GitHubCliMergeExecutor } from "../github/github-cli-merge-executor.js";
import { runTool } from "../tool-result.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "../tool-metadata.js";
import { MergeAuditService } from "./merge-audit-service.js";
import type { MergeAuditDecision } from "./merge-audit-types.js";

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

function parseDecision(value: unknown): MergeAuditDecision {
  if (value === "MERGE_APPROVED" || value === "CHANGES_REQUIRED" || value === "BLOCKED") {
    return value;
  }
  throw new Error("Merge audit decision has not been recorded");
}

function assertBoundTarget(
  status: Record<string, unknown>,
  repository: string,
  pullNumber: number,
): { repository: string; pullNumber: number } {
  const target = status.target;
  if (typeof target !== "object" || target === null) {
    throw new Error("Merge audit target binding is missing");
  }
  const value = target as { repository?: unknown; pullNumber?: unknown };
  if (value.repository !== repository || value.pullNumber !== pullNumber) {
    throw new Error("Repository or pull request does not match the target pinned by this merge audit");
  }
  return { repository, pullNumber };
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
  const repository = z.string().regex(/^[^/\s]+\/[^/\s]+$/).describe("GitHub repository in owner/name form.");
  const pullNumber = z.number().int().positive().describe("GitHub pull request number.");

  server.registerTool(
    "merge_audit_start",
    {
      title: "Start full independent merge audit",
      description:
        "Start a full final code-quality and merge-risk audit pinned to immutable repository/PR/base/head inputs. Internal review evidence is never treated as approval.",
      inputSchema: {
        repoPath,
        repository,
        pullNumber,
        baseBranch: z.string().default("main").describe("Target branch used for the proposed merge."),
        headBranch: z.string().min(1).describe("Feature branch whose current commit will be pinned for this audit."),
        request: z.string().optional().describe("Original user request or acceptance criteria."),
        internalAuditSummary: z.string().optional().describe("Optional developer-side review/validation evidence for independent verification."),
      },
      annotations: TOOL_ANNOTATIONS.additiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, repository, pullNumber, baseBranch, headBranch, request, internalAuditSummary }) =>
      runTool(() =>
        audits.start({
          repoPath,
          repository,
          pullNumber,
          baseBranch,
          headBranch,
          request,
          internalAuditSummary,
        }),
      ),
  );

  server.registerTool(
    "merge_audit_context",
    {
      title: "Get full independent merge-review context",
      description:
        "Return pinned diff, policy evidence, risk classification, mandatory review categories, validation requirement, target binding, and base/head staleness without modifying source.",
      inputSchema: { repoPath, runId },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId }) => runTool(() => audits.context({ repoPath, runId })),
  );

  server.registerTool(
    "merge_audit_decide",
    {
      title: "Record full independent merge decision",
      description:
        "Record a structured full code review with P1-P4 findings, mandatory category coverage, SHA-bound validation evidence, and the final independent decision.",
      inputSchema: {
        repoPath,
        runId,
        decision: z.enum(["MERGE_APPROVED", "CHANGES_REQUIRED", "BLOCKED"]).describe("Independent final merge decision."),
        rationale: z.string().min(1).describe("Overall evidence-based rationale for the decision."),
        findings: z.array(finding).describe("Structured code-review findings. Unresolved P1 findings block approval."),
        coverage: z.array(coverage).describe("One evidence-backed verdict for every mandatory full-review category."),
        validationEvidence: z.array(validationEvidence).describe(
          "Deterministic validation evidence. Approval requires passing evidence for the audited SHA at the risk-required profile or stronger.",
        ),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, decision, rationale, findings, coverage, validationEvidence }) =>
      runTool(() =>
        audits.decide({
          repoPath,
          runId,
          decision,
          rationale,
          findings,
          coverage,
          validationEvidence,
        }),
      ),
  );

  server.registerTool(
    "merge_audit_status",
    {
      title: "Inspect full independent merge-audit status",
      description:
        "Read target binding, current base/head pins, structured review state, validation sufficiency, quality gate, and merge readiness.",
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
        title: "Publish independent merge-audit review",
        description:
          "Publish the full SHA-bound review through the isolated auditor account only when the bound repository/PR/base/head still match.",
        inputSchema: { repoPath, runId, repository, pullNumber },
        annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
        _meta: authMetadata,
      },
      async ({ repoPath, runId, repository, pullNumber }) =>
        runTool(async () => {
          const status = await audits.status({ repoPath, runId });
          assertBoundTarget(status, repository, pullNumber);
          if (status.stale === true) {
            throw new Error("Merge audit is STALE and cannot be published. Start a fresh audit for the current base/head.");
          }
          const decision = parseDecision(status.decision);
          const rationale = typeof status.rationale === "string" ? status.rationale.trim() : "";
          const headSha = typeof status.headSha === "string" ? status.headSha : "";
          const baseBranch = typeof status.baseBranch === "string" ? status.baseBranch : "";
          const baseSha = typeof status.baseSha === "string" ? status.baseSha : "";
          const unresolvedP1 =
            typeof status.unresolvedP1 === "number" && Number.isInteger(status.unresolvedP1)
              ? status.unresolvedP1
              : 0;
          if (!rationale) throw new Error("Merge audit rationale is missing");
          if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error("Merge audit pinned head SHA is invalid");
          if (!baseBranch) throw new Error("Merge audit pinned base branch is missing");
          if (!/^[0-9a-f]{40}$/i.test(baseSha)) throw new Error("Merge audit pinned base SHA is invalid");
          if (decision === "MERGE_APPROVED" && status.readyToMerge !== true) {
            throw new Error("MERGE_APPROVED has not satisfied the full quality/validation gate");
          }
          return publisher.publish({
            repository,
            pullNumber,
            runId,
            headSha,
            baseBranch,
            baseSha,
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
        title: "Merge fully reviewed pull request",
        description:
          "Merge through the isolated auditor account only after the full independent quality gate and live GitHub base/head/review/CI gates all pass.",
        inputSchema: { repoPath, runId, repository, pullNumber },
        annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
        _meta: authMetadata,
      },
      async ({ repoPath, runId, repository, pullNumber }) =>
        runTool(async () => {
          const status = await audits.status({ repoPath, runId });
          assertBoundTarget(status, repository, pullNumber);
          if (status.stale === true || status.readyToMerge !== true) {
            throw new Error("Merge audit is not ready for merge or has become STALE");
          }
          const decision = parseDecision(status.decision);
          if (decision !== "MERGE_APPROVED") {
            throw new Error(`Merge audit decision is not MERGE_APPROVED: ${decision}`);
          }
          const headSha = typeof status.headSha === "string" ? status.headSha : "";
          const baseBranch = typeof status.baseBranch === "string" ? status.baseBranch : "";
          const baseSha = typeof status.baseSha === "string" ? status.baseSha : "";
          if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error("Merge audit pinned head SHA is invalid");
          if (!baseBranch) throw new Error("Merge audit pinned base branch is missing");
          if (!/^[0-9a-f]{40}$/i.test(baseSha)) throw new Error("Merge audit pinned base SHA is invalid");
          return executor.execute({ repository, pullNumber, headSha, baseBranch, baseSha });
        }),
    );
  }
}
