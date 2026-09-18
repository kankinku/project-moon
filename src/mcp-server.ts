import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppConfig, RuntimeRole, WorkflowMode } from "./config.js";
import { registerExecTools } from "./exec-tools.js";
import { FileService } from "./file-service.js";
import { registerFileTools } from "./file-tools.js";
import { GitHubCliAuthService } from "./github/github-cli-auth-service.js";
import { registerGitHubCliAuthTools } from "./github/github-cli-auth-tools.js";
import { GitHubCliMergeAuditPublisher } from "./github/github-cli-merge-audit-publisher.js";
import { GitHubCliMergeExecutor } from "./github/github-cli-merge-executor.js";
import { MergeAuditProxyClient } from "./merge-audit/merge-audit-proxy-client.js";
import { registerMergeAuditProxyTools } from "./merge-audit/merge-audit-proxy-tools.js";
import { MergeAuditService } from "./merge-audit/merge-audit-service.js";
import { registerMergeAuditTools } from "./merge-audit/merge-audit-tools.js";
import { ProcessManager } from "./process-manager.js";
import { ReviewService } from "./review/review-service.js";
import { registerReviewTools } from "./review/review-tools.js";
import { TaskService } from "./task/task-service.js";
import { registerTaskTools } from "./task/task-tools.js";

export function workflowInstructions(
  mode: WorkflowMode,
  role: RuntimeRole = "developer",
): string {
  if (role === "merge-auditor") {
    return "This Project Moon runtime is an independent FINAL MERGE AUDITOR. It must not implement, repair, modify, or execute reviewed repository code. Use merge_auditor_auth_* only to bootstrap/check the isolated GitHub sub-account login, and merge_audit_* to pin the repository/PR/base/head, perform a full evidence-based review of requirements, correctness, code quality, tests, regression, architecture, API contracts, security, performance, operations, and maintainability, use merge_audit_context includePaths/searchTerms to inspect unchanged callers and related code at the exact audited head SHA, record structured P1-P4 findings plus validation evidence, and publish the SHA-bound PR review through that account. Internal developer review is evidence only, never approval. MERGE_APPROVED requires complete review coverage, no unresolved P1, backend-verified Moon task validation evidence at the required profile for the exact head SHA, and unchanged base/head pins. github_ci, external_ci, and moon_review evidence are supplemental until provider-backed resolvers exist. Never expose GitHub tokens or passwords.";
  }

  const common =
    "This server is an unrestricted remote development environment. Tools operate directly on the host with the MCP service process's full OS permissions. DIRECT and HARNESS are workflow policies, not security boundaries. Explicit user instructions to use DIRECT or HARNESS for the current request override the server default when compatible with the requested operation. Use review_* for independent reproducible code review pinned to Git commits. Final merge approval belongs to a separate merge-auditor runtime. When merge_audit_* tools are exposed here, they are private-network proxies to that isolated runtime rather than local developer authority. Poll long-running commands with read_process or write_stdin.";

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
  mergeAuditService: MergeAuditService;
  githubCliAuthService: GitHubCliAuthService;
  githubMergeAuditPublisher: GitHubCliMergeAuditPublisher;
  githubMergeExecutor: GitHubCliMergeExecutor;
  mergeAuditProxyClient: MergeAuditProxyClient | undefined;
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
    mergeAuditService: new MergeAuditService({ stateRoot: config.mergeAuditStateDir }),
    githubCliAuthService: new GitHubCliAuthService({
      expectedAuditorLogin: config.githubAuditorLogin,
    }),
    githubMergeAuditPublisher: new GitHubCliMergeAuditPublisher({
      expectedAuditorLogin: config.githubAuditorLogin,
    }),
    githubMergeExecutor: new GitHubCliMergeExecutor({
      expectedAuditorLogin: config.githubAuditorLogin,
    }),
    mergeAuditProxyClient:
      config.mergeAuditorProxyEnabled && config.mergeAuditorInternalUrl && config.mergeAuditorInternalToken
        ? new MergeAuditProxyClient({
            url: config.mergeAuditorInternalUrl,
            token: config.mergeAuditorInternalToken,
            timeoutMs: config.mergeAuditorRequestTimeoutMs,
          })
        : undefined,
  };
}

export function createMcpServer(config: AppConfig, services: McpServices): McpServer {
  const server = new McpServer(
    {
      name: config.runtimeRole === "merge-auditor" ? "project-moon-merge-auditor" : "project-moon",
      version: "0.1.0",
    },
    {
      instructions: workflowInstructions(config.workflowMode, config.runtimeRole),
      capabilities: { logging: {} },
    },
  );

  if (config.runtimeRole === "merge-auditor") {
    if (!config.mergeAuditEnabled) {
      throw new Error("MCP_RUNTIME_ROLE=merge-auditor requires MCP_MERGE_AUDIT_ENABLED=true");
    }
    registerGitHubCliAuthTools(server, config, services.githubCliAuthService);
    registerMergeAuditTools(
      server,
      config,
      services.mergeAuditService,
      services.githubMergeAuditPublisher,
      services.githubMergeExecutor,
    );
    return server;
  }

  registerExecTools(server, config, services.processManager, services.fileService);
  registerFileTools(server, config, services.fileService);
  registerTaskTools(server, config, services.taskService);
  registerReviewTools(server, config, services.reviewService);
  if (services.mergeAuditProxyClient) {
    registerMergeAuditProxyTools(server, config, services.mergeAuditProxyClient);
  }
  return server;
}
