import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppConfig, WorkflowMode } from "./config.js";
import { registerExecTools } from "./exec-tools.js";
import { FileService } from "./file-service.js";
import { registerFileTools } from "./file-tools.js";
import { ProcessManager } from "./process-manager.js";
import { ReviewService } from "./review/review-service.js";
import { registerReviewTools } from "./review/review-tools.js";
import { TaskService } from "./task/task-service.js";
import { registerTaskTools } from "./task/task-tools.js";


export function workflowInstructions(mode: WorkflowMode): string {
  const common =
    "This server is an unrestricted remote development environment. Tools operate directly on the host with the MCP service process's full OS permissions. DIRECT and HARNESS are workflow policies, not security boundaries. Explicit user instructions to use DIRECT or HARNESS for the current request override the server default when compatible with the requested operation. Use review_* for independent reproducible code review pinned to Git commits. Poll long-running commands with read_process or write_stdin.";

  if (mode === "direct") {
    return `${common} Default workflow: DIRECT. Prefer exec_command/run_script and file tools immediately, without creating task_* lifecycle state, for diagnostics, one-shot operations, and clearly scoped changes. Run relevant deterministic checks directly when code changes. Escalate to task_* only when the user asks for HARNESS or the work becomes materially multi-step, architectural, high-risk, or needs reproducible validation evidence.`;
  }
  if (mode === "harness") {
    return `${common} Default workflow: HARNESS. For repository modifications beyond trivial/read-only operations, use task_start -> task_context(brief) -> task_record(context_brief) -> task_context(plan) -> task_record(plan) -> implementation -> task_validate -> task_complete. Read-only inspection and simple operational queries may still use direct tools without a task run.`;
  }
  return `${common} Default workflow: AUTO. Use DIRECT (exec/file tools without task lifecycle state) for read-only inspection, health checks, one-shot commands, file transfer, and small localized changes with obvious validation. Use HARNESS (task_*) for multi-file or multi-step changes, architecture/refactors, dependency/schema work, security/auth, deployment/network/migration/destructive operations, or work that benefits from durable context and fingerprinted validation. If DIRECT work grows in scope or risk, escalate to HARNESS before continuing.`;
}

export interface McpServices {
  processManager: ProcessManager;
  fileService: FileService;
  reviewService: ReviewService;
  taskService: TaskService;
}

export function createServices(config: AppConfig): McpServices {
  return {
    processManager: new ProcessManager({
      maxRetainedOutputBytes: config.maxRetainedProcessOutputBytes,
      processRetentionMs: config.processRetentionMs,
      maxProcesses: config.maxProcesses,
      defaultMaxOutputBytes: config.maxOutputBytes,
    }),
    fileService: new FileService({
      defaultCwd: config.defaultCwd,
      maxChunkBytes: config.maxFileChunkBytes,
      maxEditFileBytes: config.maxEditFileBytes,
      maxOutputBytes: config.maxOutputBytes,
    }),
    reviewService: new ReviewService(),
    taskService: new TaskService(),
  };
}

export function createMcpServer(config: AppConfig, services: McpServices): McpServer {
  const server = new McpServer(
    {
      name: "project-moon",
      version: "0.1.0",
    },
    {
      instructions: workflowInstructions(config.workflowMode),
      capabilities: { logging: {} },
    },
  );

  registerExecTools(
    server,
    config,
    services.processManager,
    services.fileService,
  );
  registerFileTools(server, config, services.fileService);
  registerTaskTools(server, config, services.taskService);
  registerReviewTools(server, config, services.reviewService);
  return server;
}
