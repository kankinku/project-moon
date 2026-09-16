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

async function run(repo: string) {
  try {
    const result = await execFileAsync(process.execPath, [checker, "--repo", repo, "--json"], { encoding: "utf8" });
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
});
