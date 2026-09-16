import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "../config.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "../tool-metadata.js";
import { runTool } from "../tool-result.js";
import { TaskService } from "./task-service.js";

export function registerTaskTools(
  server: McpServer,
  config: AppConfig,
  tasks: TaskService,
): void {
  const authMetadata = toolAuthMetadata(config);
  const repoPath = z.string().min(1).describe("Path inside the Git repository for the task.");
  const runId = z.string().min(1).describe("Task run ID returned by task_start.");

  server.registerTool(
    "task_start",
    {
      title: "Start AI-native development task",
      description:
        "Pin the current Git baseline, discover repository structure and policies, classify initial risk, and create an ephemeral task run under .moon/tasks before implementation begins.",
      inputSchema: {
        repoPath,
        request: z.string().min(1).describe("User goal expressed primarily as desired outcome and constraints rather than implementation details."),
        domainContext: z.string().optional().describe("Real-world workflow, exceptions, constraints, and tacit domain context that materially affect the implementation."),
        riskHint: z.enum(["auto", "low", "medium", "high"]).default("auto").describe("Optional minimum risk hint. Automatic classification may raise but never lower it."),
        requireClean: z.boolean().default(true).describe("Require a clean Git working tree before pinning the task baseline."),
      },
      annotations: TOOL_ANNOTATIONS.additiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, request, domainContext, riskHint, requireClean }) =>
      runTool(() => tasks.start({ repoPath, request, domainContext, riskHint, requireClean })),
  );

  server.registerTool(
    "task_context",
    {
      title: "Get task-stage context",
      description:
        "Return bounded context for briefing, planning, implementation, or validation so the agent aligns on repository structure before changing code.",
      inputSchema: {
        repoPath,
        runId,
        stage: z.enum(["brief", "plan", "execute", "validate"]).describe("Task context stage: brief for repository understanding, plan for implementation design, execute for plan-guided changes, or validate for programmatic verification."),
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, stage }) => runTool(() => tasks.context({ repoPath, runId, stage })),
  );

  server.registerTool(
    "task_record",
    {
      title: "Record task briefing or plan",
      description:
        "Persist an ephemeral context brief or implementation plan. Updating upstream task artifacts invalidates downstream validation evidence.",
      inputSchema: {
        repoPath,
        runId,
        kind: z.enum(["context_brief", "plan"]).describe("Artifact kind to persist. context_brief must be recorded before plan."),
        content: z.string().min(1).describe("Markdown content for the task context brief or implementation plan."),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, kind, content }) =>
      runTool(() => tasks.record({ repoPath, runId, kind, content })),
  );

  server.registerTool(
    "task_validate",
    {
      title: "Run risk-aware task validation",
      description:
        "Reclassify risk from the actual changed paths, enforce the minimum validation profile, run programmatic checks, and fingerprint the verified Git/worktree state.",
      inputSchema: {
        repoPath,
        runId,
        profile: z.string().min(1).optional().describe("Validation profile. Omit to use the minimum required profile for the current risk."),
        timeoutMs: z.number().int().min(1000).max(60 * 60 * 1000).default(5 * 60 * 1000).describe("Per-command timeout in milliseconds."),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, profile, timeoutMs }) =>
      runTool(() => tasks.validate({ repoPath, runId, profile, timeoutMs })),
  );

  server.registerTool(
    "task_complete",
    {
      title: "Complete verified task",
      description:
        "Mark a task complete only when its latest programmatic validation passed and the working-tree fingerprint has not changed since validation.",
      inputSchema: {
        repoPath,
        runId,
        summary: z.string().optional().describe("Optional ephemeral completion summary stored under .moon/tasks."),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId, summary }) => runTool(() => tasks.complete({ repoPath, runId, summary })),
  );

  server.registerTool(
    "task_status",
    {
      title: "Inspect task lifecycle status",
      description:
        "Return task state, current risk, changed paths, validation freshness, worktree fingerprint, and whether the task is ready to complete. Changes after validation make the effective state STALE.",
      inputSchema: { repoPath, runId },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ repoPath, runId }) => runTool(() => tasks.status({ repoPath, runId })),
  );
}
