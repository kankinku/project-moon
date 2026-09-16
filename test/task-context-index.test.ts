import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { buildRepositoryIndex, repositoryContextSummary } from "../src/task/task-context-index.js";
import { TaskRepository } from "../src/task/task-repository.js";

const execFileAsync = promisify(execFile);

async function git(repo: string, args: string[]) {
  await execFileAsync("git", ["-C", repo, ...args]);
}

describe("task repository context index", () => {
  it("builds a compact module map and prioritizes request-relevant files", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "moon-context-index-"));
    await mkdir(path.join(repo, "src", "auth"), { recursive: true });
    await mkdir(path.join(repo, "src", "billing"), { recursive: true });
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(path.join(repo, "src", "auth", "oauth-service.ts"), "export const oauth = true;\n");
    await writeFile(path.join(repo, "src", "billing", "invoice-service.ts"), "export const invoice = true;\n");
    await writeFile(path.join(repo, "test", "oauth-service.test.ts"), "export {};\n");
    await writeFile(path.join(repo, "README.md"), "# Demo\n");
    await writeFile(path.join(repo, "package.json"), '{"scripts":{"test":"vitest run"}}\n');
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["add", "."]);
    await git(repo, ["-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "base"]);
    const headSha = (await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();

    const repository = new TaskRepository();
    const index = await buildRepositoryIndex(repository, repo, headSha);
    expect(index.counts).toMatchObject({ total: 5, source: 2, test: 1, docs: 1, config: 1 });
    expect(index.modules).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "src/auth", source: 1 }),
      expect.objectContaining({ name: "src/billing", source: 1 }),
      expect.objectContaining({ name: "test", tests: 1 }),
    ]));

    const summary = repositoryContextSummary(index, "Fix OAuth authentication regression") as {
      relevantFiles: Array<{ path: string }>;
    };
    expect(summary.relevantFiles[0]?.path).toContain("oauth");
    expect(summary.relevantFiles.map((entry) => entry.path)).toContain("src/auth/oauth-service.ts");
    expect(summary.relevantFiles.map((entry) => entry.path)).not.toContain("src/billing/invoice-service.ts");
  });
});
