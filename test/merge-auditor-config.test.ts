import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("merge auditor config", () => {
  it("defaults to the developer runtime with merge audit disabled", () => {
    const config = loadConfig({ MCP_AUTH_TOKEN: "secret" }, "/tmp/moon");

    expect(config.runtimeRole).toBe("developer");
    expect(config.mergeAuditEnabled).toBe(false);
    expect(config.mergeAuditStateDir).toBeUndefined();
    expect(config.githubAuditorLogin).toBeUndefined();
  });

  it("loads the isolated auditor role, state directory, and expected secondary account", () => {
    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "secret",
        MCP_RUNTIME_ROLE: "merge-auditor",
        MCP_MERGE_AUDIT_ENABLED: "true",
        MCP_MERGE_AUDIT_STATE_DIR: "/var/lib/project-moon/merge-audits",
        MCP_GITHUB_AUDITOR_LOGIN: "  moon-auditor  ",
      },
      "/tmp/moon",
    );

    expect(config.runtimeRole).toBe("merge-auditor");
    expect(config.mergeAuditEnabled).toBe(true);
    expect(config.mergeAuditStateDir).toBe(path.resolve("/var/lib/project-moon/merge-audits"));
    expect(config.githubAuditorLogin).toBe("moon-auditor");
  });

  it("rejects unknown runtime roles", () => {
    expect(() =>
      loadConfig(
        {
          MCP_AUTH_TOKEN: "secret",
          MCP_RUNTIME_ROLE: "developer-and-auditor",
        },
        "/tmp/moon",
      ),
    ).toThrow(/MCP_RUNTIME_ROLE/);
  });
});
