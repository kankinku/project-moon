import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type JsonRecord = Record<string, unknown>;

interface RpcResponse {
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

const ALLOWED_PROXY_TOOLS = new Set([
  "merge_audit_start",
  "merge_audit_context",
  "merge_audit_decide",
  "merge_audit_status",
  "merge_audit_publish",
  "merge_audit_merge",
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCallToolResult(value: unknown): CallToolResult {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new Error("Merge-auditor returned an invalid MCP tool result");
  }
  for (const item of value.content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
      throw new Error("Merge-auditor returned unsupported MCP content");
    }
  }
  if (value.structuredContent !== undefined && !isRecord(value.structuredContent)) {
    throw new Error("Merge-auditor returned invalid structuredContent");
  }
  if (value.isError !== undefined && typeof value.isError !== "boolean") {
    throw new Error("Merge-auditor returned an invalid isError flag");
  }
  return value as CallToolResult;
}

export function mapDeveloperRepoPathToAuditor(repoPath: string): string {
  const normalized = repoPath.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (normalized === "/shared") return "/audit/shared";
  if (!normalized.startsWith("/shared/")) {
    throw new Error("Merge-auditor proxy only accepts repositories under /shared");
  }
  return `/audit/shared${normalized.slice("/shared".length)}`;
}

export class MergeAuditProxyClient {
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor(options: { url: string; token: string; timeoutMs: number }) {
    this.#url = options.url;
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs;
  }

  async callTool(name: string, arguments_: JsonRecord): Promise<CallToolResult> {
    if (!ALLOWED_PROXY_TOOLS.has(name)) {
      throw new Error(`Unsupported merge-auditor proxy tool: ${name}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetch(this.#url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name,
            arguments: arguments_,
          },
        }),
        signal: controller.signal,
      });

      const body = await response.text();
      if (!response.ok) {
        throw new Error(`Merge-auditor RPC failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
      }

      let payload: RpcResponse;
      try {
        payload = JSON.parse(body) as RpcResponse;
      } catch {
        throw new Error("Merge-auditor returned invalid JSON");
      }
      if (payload.error) {
        const message =
          typeof payload.error.message === "string"
            ? payload.error.message
            : "Merge-auditor RPC returned an error";
        throw new Error(message);
      }
      return parseCallToolResult(payload.result);
    } finally {
      clearTimeout(timeout);
    }
  }
}
