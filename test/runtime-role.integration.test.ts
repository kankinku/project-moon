import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

async function listToolsFor(env: NodeJS.ProcessEnv): Promise<string[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "moon-role-test-"));
  const config = loadConfig(
    {
      MCP_AUTH_TOKEN: "role-test-secret",
      MCP_HOST: "127.0.0.1",
      MCP_DEFAULT_CWD: root,
      ...env,
    },
    root,
  );
  config.port = 0;
  let running: RunningHttpServer | undefined;
  let client: Client | undefined;
  try {
    running = await startHttpServer(config, createServices(config));
    const address = running.httpServer.address() as AddressInfo;
    const endpoint = new URL(`http://127.0.0.1:${address.port}${config.endpoint}`);
    client = new Client({ name: "runtime-role-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: "Bearer role-test-secret" } },
    });
    await client.connect(transport);
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client?.close().catch(() => undefined);
    await running?.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe("runtime role tool isolation", () => {
  it("does not expose final merge decision or auditor auth tools from the developer runtime", async () => {
    const tools = await listToolsFor({ MCP_RUNTIME_ROLE: "developer" });

    expect(tools).toContain("exec_command");
    expect(tools).toContain("review_start");
    expect(tools).not.toContain("merge_audit_start");
    expect(tools).not.toContain("merge_audit_decide");
    expect(tools).not.toContain("merge_audit_publish");
    expect(tools).not.toContain("merge_auditor_auth_start");
  });

  it("exposes only auditor auth and merge audit tools from the merge-auditor runtime", async () => {
    const tools = await listToolsFor({
      MCP_RUNTIME_ROLE: "merge-auditor",
      MCP_MERGE_AUDIT_ENABLED: "true",
    });

    expect(tools).toEqual([
      "merge_audit_context",
      "merge_audit_decide",
      "merge_audit_publish",
      "merge_audit_start",
      "merge_audit_status",
      "merge_auditor_auth_cancel",
      "merge_auditor_auth_start",
      "merge_auditor_auth_status",
    ]);
    expect(tools).not.toContain("exec_command");
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("review_worktree");
  });
});
