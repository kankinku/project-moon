import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const checker = path.resolve("scripts/check-architecture.mjs");

async function git(repo: string, args: string[]) {
  await execFileAsync("git", ["-C", repo, ...args]);
}

async function run(repo: string, env: NodeJS.ProcessEnv = {}) {
  try {
    const result = await execFileAsync(process.execPath, [checker, "--repo", repo, "--json"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { exitCode: 0, stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { exitCode: failure.code ?? 1, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? "") };
  }
}

describe("architecture checker", () => {
  it("passes valid dependencies and rejects forbidden layer imports", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "moon-architecture-"));
    await mkdir(path.join(repo, "src", "transport"), { recursive: true });
    await mkdir(path.join(repo, "src", "application"), { recursive: true });
    await mkdir(path.join(repo, "src", "infra"), { recursive: true });
    await writeFile(path.join(repo, "moon.config.json"), JSON.stringify({
      architecture: {
        layers: [
          { name: "transport", patterns: ["^src/transport/"] },
          { name: "application", patterns: ["^src/application/"] },
          { name: "infra", patterns: ["^src/infra/"] },
        ],
        deny: [
          { from: "application", to: "transport" },
          { from: "infra", to: "application" },
        ],
        maxFileLines: [{ pattern: "^src/application/", max: 20 }],
      },
    }, null, 2));
    await writeFile(path.join(repo, "src", "transport", "controller.ts"), 'import { service } from "../application/service.js";\nexport const controller = service;\n');
    await writeFile(path.join(repo, "src", "application", "service.ts"), 'import { repo } from "../infra/repo.js";\nexport const service = repo;\n');
    await writeFile(path.join(repo, "src", "infra", "repo.ts"), 'export const repo = "ok";\n');
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["add", "."]);

    const passing = await run(repo);
    expect(passing.exitCode).toBe(0);
    expect(JSON.parse(passing.stdout)).toMatchObject({ status: "PASS" });

    await writeFile(path.join(repo, "src", "infra", "repo.ts"), 'import { service } from "../application/service.js";\nexport const repo = service;\n');
    const failing = await run(repo);
    expect(failing.exitCode).toBe(1);
    const result = JSON.parse(failing.stdout);
    expect(result.status).toBe("FAIL");
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "dependency", message: "forbidden architecture dependency: infra -> application" }),
    ]));
  });

  it("uses MOON_CONFIG_PATH so a weakened live policy cannot bypass pinned architecture rules", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "moon-architecture-pinned-"));
    await mkdir(path.join(repo, "src", "application"), { recursive: true });
    await mkdir(path.join(repo, "src", "infra"), { recursive: true });
    await mkdir(path.join(repo, ".moon", "tasks", "test-run"), { recursive: true });

    const strictPolicy = {
      architecture: {
        layers: [
          { name: "application", patterns: ["^src/application/"] },
          { name: "infra", patterns: ["^src/infra/"] },
        ],
        deny: [{ from: "infra", to: "application" }],
        maxFileLines: [],
      },
    };
    const pinnedPath = path.join(repo, ".moon", "tasks", "test-run", "harness-policy.json");
    await writeFile(pinnedPath, JSON.stringify(strictPolicy, null, 2));
    await writeFile(path.join(repo, "moon.config.json"), JSON.stringify({
      architecture: {
        layers: [],
        deny: [],
        maxFileLines: [],
      },
    }, null, 2));
    await writeFile(path.join(repo, "src", "application", "service.ts"), 'export const service = "app";\n');
    await writeFile(path.join(repo, "src", "infra", "repo.ts"), 'import { service } from "../application/service.js";\nexport const repo = service;\n');
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["add", "moon.config.json", "src"]);

    const livePolicy = await run(repo);
    expect(livePolicy.exitCode).toBe(0);
    expect(JSON.parse(livePolicy.stdout)).toMatchObject({ status: "PASS" });

    const pinnedPolicy = await run(repo, { MOON_CONFIG_PATH: pinnedPath });
    expect(pinnedPolicy.exitCode).toBe(1);
    expect(JSON.parse(pinnedPolicy.stdout).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "dependency",
        message: "forbidden architecture dependency: infra -> application",
      }),
    ]));
  });
});
