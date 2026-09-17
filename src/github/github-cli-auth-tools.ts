import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "../config.js";
import { runTool } from "../tool-result.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "../tool-metadata.js";
import { GitHubCliAuthService } from "./github-cli-auth-service.js";

export function registerGitHubCliAuthTools(
  server: McpServer,
  config: AppConfig,
  auth: GitHubCliAuthService,
): void {
  const authMetadata = toolAuthMetadata(config);

  server.registerTool(
    "merge_auditor_auth_start",
    {
      title: "Start merge-auditor GitHub login",
      description:
        "Start GitHub CLI browser authentication inside the isolated merge-auditor container. Returns only the GitHub verification URL and one-time code. No GitHub token or password is returned through MCP.",
      inputSchema: {},
      annotations: TOOL_ANNOTATIONS.additiveNonIdempotentOpen,
      _meta: authMetadata,
    },
    async () => runTool(() => auth.start()),
  );

  server.registerTool(
    "merge_auditor_auth_status",
    {
      title: "Check merge-auditor GitHub login",
      description:
        "Check whether the isolated GitHub CLI login completed and which GitHub account is active. Tokens are never returned.",
      inputSchema: {
        authorizationId: z.string().uuid().optional(),
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ authorizationId }) => runTool(() => auth.status({ authorizationId })),
  );

  server.registerTool(
    "merge_auditor_auth_cancel",
    {
      title: "Cancel merge-auditor GitHub login",
      description: "Cancel a pending GitHub CLI browser authentication session.",
      inputSchema: {
        authorizationId: z.string().uuid().optional(),
      },
      annotations: TOOL_ANNOTATIONS.destructiveIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ authorizationId }) => runTool(() => auth.cancel({ authorizationId })),
  );
}
