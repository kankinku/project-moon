import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const checker = path.resolve("scripts/audit-docs.mjs");

async function git(repo: string, args: string[]) {
  await execFileAsync("git", ["-C", repo, ...args]);
}

async function run(repo: string, env: NodeJS.ProcessEnv = {}) {
  const childEnv = { ...process.env, ...env };
  if (!Object.prototype.hasOwnProperty.call(env, "MOON_CONFIG_PATH")) delete childEnv.MOON_CONFIG_PATH;
  try {
    const result = await execFileAsync(process.execPath, [checker, "--repo", repo, "--json"], {
      encoding: "utf8",
      env: childEnv,
    });
    return { exitCode: 0, stdout: String(result.stdout) };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string };
    return { exitCode: failure.code ?? 1, stdout: String(failure.stdout ?? "") };
  }
}

describe("documentation knowledge audit", () => {
  it("rejects ephemeral tracked docs and broken local links", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "moon-docs-audit-"));
    await mkdir(path.join(repo, "docs", "plans"), { recursive: true });
    await writeFile(path.join(repo, "moon.config.json"), JSON.stringify({
      knowledge: {
        maxPermanentDocs: 50,
        ephemeralPatterns: ["^docs/plans/"],
        generatedPatterns: [],
      },
    }, null, 2));
    await writeFile(path.join(repo, "README.md"), "# Demo\n\n[missing](docs/missing.md)\n");
    await writeFile(path.join(repo, "docs", "plans", "temporary.md"), "# Temporary implementation plan\n");
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["add", "."]);

    const result = await run(repo);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ephemeral-doc", file: "docs/plans/temporary.md" }),
      expect.objectContaining({ type: "broken-link", file: "README.md", target: "docs/missing.md" }),
    ]));

    await writeFile(path.join(repo, "docs", "plans", "untracked.md"), "# Untracked temporary plan\n");
    const withUntracked = await run(repo);
    expect(JSON.parse(withUntracked.stdout).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ephemeral-doc", file: "docs/plans/untracked.md" }),
    ]));
  });

  it("uses pinned knowledge policy from MOON_CONFIG_PATH", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "moon-docs-pinned-"));
    await mkdir(path.join(repo, "docs", "plans"), { recursive: true });
    await mkdir(path.join(repo, ".moon", "tasks", "run"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Demo\n");
    await writeFile(path.join(repo, "docs", "plans", "temporary.md"), "# Temporary\n");
    await writeFile(path.join(repo, "moon.config.json"), JSON.stringify({
      knowledge: { maxPermanentDocs: 50, ephemeralPatterns: [], generatedPatterns: [] },
    }, null, 2));
    const pinnedPath = path.join(repo, ".moon", "tasks", "run", "harness-policy.json");
    await writeFile(pinnedPath, JSON.stringify({
      knowledge: { maxPermanentDocs: 50, ephemeralPatterns: ["^docs/plans/"], generatedPatterns: [] },
    }, null, 2));
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["add", "README.md", "docs", "moon.config.json"]);

    expect((await run(repo)).exitCode).toBe(0);
    const pinned = await run(repo, { MOON_CONFIG_PATH: pinnedPath });
    expect(pinned.exitCode).toBe(1);
    expect(JSON.parse(pinned.stdout).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ephemeral-doc", file: "docs/plans/temporary.md" }),
    ]));
  });
});
