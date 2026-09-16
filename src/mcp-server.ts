import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppConfig } from "./config.js";
import { registerExecTools } from "./exec-tools.js";
import { FileService } from "./file-service.js";
import { registerFileTools } from "./file-tools.js";
import { ProcessManager } from "./process-manager.js";
import { ReviewService } from "./review/review-service.js";
import { registerReviewTools } from "./review/review-tools.js";
import { TaskService } from "./task/task-service.js";
import { registerTaskTools } from "./task/task-tools.js";

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
      instructions:
        "This server is an unrestricted remote development environment. Tools operate directly on the host with the MCP service process's full OS permissions. For substantial repository work, use task_* to align context, record a plan, classify risk, and run fingerprinted programmatic validation before completion; use review_* for independent reproducible code review pinned to Git commits. Use exec_command/run_script as execution escape hatches and file tools for direct file operations. Poll long-running commands with read_process or write_stdin.",
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
