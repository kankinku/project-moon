import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  MergeAuditProxyClient,
  mapDeveloperRepoPathToAuditor,
} from "../src/merge-audit/merge-audit-proxy-client.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("MergeAuditProxyClient", () => {
  it("maps only developer shared-workspace paths into the read-only auditor mount", () => {
    expect(mapDeveloperRepoPathToAuditor("/shared/repo")).toBe("/audit/shared/repo");
    expect(mapDeveloperRepoPathToAuditor("/shared/nested/repo/")).toBe("/audit/shared/nested/repo");
    expect(() => mapDeveloperRepoPathToAuditor("/etc")).toThrow(/only accepts repositories under \/shared/);
  });

  it("forwards only allowlisted merge tools with the internal bearer credential", async () => {
    let authorization = "";
    let body: unknown;
    const server = createServer((request, response) => {
      authorization = String(request.headers.authorization ?? "");
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: "{\"ok\":true}" }],
              structuredContent: { ok: true },
            },
          }),
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as AddressInfo;

    const client = new MergeAuditProxyClient({
      url: `http://127.0.0.1:${address.port}/mcp`,
      token: "internal-secret",
      timeoutMs: 5_000,
    });
    const result = await client.callTool("merge_audit_status", {
      repoPath: "/audit/shared/repo",
      runId: "audit-1",
    });

    expect(authorization).toBe("Bearer internal-secret");
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "merge_audit_status",
        arguments: {
          repoPath: "/audit/shared/repo",
          runId: "audit-1",
        },
      },
    });
    expect(result.structuredContent).toEqual({ ok: true });

    await expect(client.callTool("exec_command", {})).rejects.toThrow(/Unsupported merge-auditor proxy tool/);
  });
});
