import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "../config.js";
import { runTool } from "../tool-result.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "../tool-metadata.js";
import { ReviewService } from "./review-service.js";

export function registerReviewTools(
  server: McpServer,
  config: AppConfig,
  reviews: ReviewService,
): void {
  const authMetadata = toolAuthMetadata(config);
  const repoPath = z.string().min(1).describe("Path inside the Git repository to review.");
  const runId = z.string().min(1).describe("Review run ID returned by review_start.");

  server.registerTool(
    "review_start",
    {
      title: "Start code review run",
      description:
        "Create a reproducible review run pinned to base/head commits, record changed files and diff stats, and initialize local review artifacts under .moon/reviews.",
      inputSchema: {
        repoPath,
        baseBranch: z.string().default("main").describe("Base branch or commitish used to compute the review merge-base."),
        headBranch: z.string().optional().describe("Head branch to review. Defaults to the currently checked-out named branch."),
        request: z.string().optional().describe("Original user request or implementation goal to persist as review context."),
      },
      annotations: TOOL_ANNOTATIONS.additiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, baseBranch, headBranch, request }) =>
      runTool(() => reviews.start({ repoPath, baseBranch, headBranch, request })),
  );

  server.registerTool(
    "review_context",
    {
      title: "Get review-stage context",
      description:
        "Return bounded, stage-specific review context from the pinned Git diff, request, design artifacts, and project policy documents without changing the repository.",
      inputSchema: {
        repoPath,
        runId,
        stage: z.enum(["intent", "criteria", "review", "fix"]).describe("Review pipeline stage whose minimal context should be assembled."),
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, stage }) => runTool(() => reviews.context({ repoPath, runId, stage })),
  );

  server.registerTool(
    "review_record",
    {
      title: "Record review artifact",
      description:
        "Persist a review artifact and advance the review state when prerequisites are satisfied. Artifacts include design intent, criteria, PR body, findings, decisions, and final report.",
      inputSchema: {
        repoPath,
        runId,
        kind: z.enum(["design_intent", "criteria", "pr_body", "review", "decisions", "final_report"]).describe("Artifact kind to write into the review run."),
        content: z.string().min(1).describe("Complete UTF-8 artifact content to persist."),
        p1Findings: z.number().int().min(0).optional().describe("Required when kind=review: number of blocking P1 findings in this review."),
        unresolvedP1: z.number().int().min(0).optional().describe("Required when kind=decisions: number of P1 findings that remain unresolved after decisions."),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, kind, content, p1Findings, unresolvedP1 }) =>
      runTool(() => reviews.record({ repoPath, runId, kind, content, p1Findings, unresolvedP1 })),
  );

  server.registerTool(
    "review_worktree",
    {
      title: "Manage review worktree",
      description:
        "Create, inspect, or remove an isolated Git worktree pinned to the reviewed commit. Writable mode creates a dedicated moon-review branch for fixes.",
      inputSchema: {
        repoPath,
        runId,
        action: z.enum(["create", "status", "remove"]).describe("Worktree lifecycle action to perform."),
        writable: z.boolean().default(false).describe("When creating, make a dedicated writable branch instead of a detached analysis worktree."),
        force: z.boolean().default(false).describe("Force worktree removal and, when requested, branch deletion even if Git considers it unsafe."),
        deleteBranch: z.boolean().default(false).describe("When removing a writable worktree, also delete its dedicated review branch."),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, action, writable, force, deleteBranch }) =>
      runTool(() => reviews.worktree({ repoPath, runId, action, writable, force, deleteBranch })),
  );

  server.registerTool(
    "review_qa",
    {
      title: "Run review QA gate",
      description:
        "Run sequential QA commands in the review worktree or repository, persist command evidence, and mark the review QA/QA_FAILED. Defaults to available npm test, typecheck, and build scripts.",
      inputSchema: {
        repoPath,
        runId,
        commands: z.array(z.string().min(1)).optional().describe("Shell commands to run sequentially. Omit to auto-detect npm test/typecheck/build scripts."),
        useWorktree: z.boolean().default(true).describe("Run QA in the review worktree when one exists; otherwise use the repository root."),
        timeoutMs: z.number().int().min(1000).max(60 * 60 * 1000).default(5 * 60 * 1000).describe("Per-command timeout in milliseconds."),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, commands, useWorktree, timeoutMs }) =>
      runTool(() => reviews.qa({ repoPath, runId, commands, useWorktree, timeoutMs })),
  );

  server.registerTool(
    "review_status",
    {
      title: "Inspect review status",
      description:
        "Return the persisted review manifest, current-vs-pinned HEAD staleness, worktree availability, QA evidence, and whether the run is ready for a future push gate.",
      inputSchema: { repoPath, runId },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId }) => runTool(() => reviews.status({ repoPath, runId })),
  );
}
