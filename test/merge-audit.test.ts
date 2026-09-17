import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { MergeAuditService } from "../src/merge-audit/merge-audit-service.js";

const execFileAsync = promisify(execFile);

async function git(repo: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return String(result.stdout).trimEnd();
}

async function commitFile(repo: string, name: string, content: string, message: string): Promise<string> {
  await writeFile(path.join(repo, name), content, "utf8");
  await git(repo, "add", name);
  await git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

describe("independent merge audit", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{ repo: string; featureSha: string }> {
    const repo = await mkdtemp(path.join(os.tmpdir(), "project-moon-merge-audit-"));
    roots.push(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "Moon Test");
    await git(repo, "config", "user.email", "moon-test@example.invalid");
    await commitFile(repo, "base.txt", "base\n", "base");
    await git(repo, "checkout", "-b", "feature/audit");
    const featureSha = await commitFile(repo, "feature.txt", "feature\n", "feature");
    return { repo, featureSha };
  }

  it("binds merge approval to the exact audited head SHA", async () => {
    const { repo, featureSha } = await fixture();
    const service = new MergeAuditService();
    const started = await service.start({
      repoPath: repo,
      baseBranch: "main",
      headBranch: "feature/audit",
      request: "Add the feature safely",
      internalAuditSummary: "Internal validation passed",
    });

    expect(started).toMatchObject({ headSha: featureSha, state: "INPUT_PINNED" });

    const context = await service.context({ repoPath: repo, runId: String(started.runId) });
    expect(context).toMatchObject({ pinnedHeadSha: featureSha, stale: false });
    expect(String(context.diff)).toContain("feature.txt");

    const decision = await service.decide({
      repoPath: repo,
      runId: String(started.runId),
      decision: "MERGE_APPROVED",
      rationale: "Pinned diff satisfies the request and contains no blocking finding.",
      unresolvedP1: 0,
    });
    expect(decision).toMatchObject({
      decision: "MERGE_APPROVED",
      approvalSha: featureSha,
      readyToMerge: true,
    });

    const status = await service.status({ repoPath: repo, runId: String(started.runId) });
    expect(status).toMatchObject({
      stale: false,
      approvalMatchesCurrentHead: true,
      readyToMerge: true,
    });
  });

  it("invalidates a prior approval when the reviewed branch moves", async () => {
    const { repo } = await fixture();
    const service = new MergeAuditService();
    const started = await service.start({
      repoPath: repo,
      baseBranch: "main",
      headBranch: "feature/audit",
    });
    await service.decide({
      repoPath: repo,
      runId: String(started.runId),
      decision: "MERGE_APPROVED",
      rationale: "No blocking findings in the pinned revision.",
      unresolvedP1: 0,
    });

    await commitFile(repo, "after-audit.txt", "changed after approval\n", "move head");

    const status = await service.status({ repoPath: repo, runId: String(started.runId) });
    expect(status).toMatchObject({
      stale: true,
      effectiveState: "STALE",
      approvalMatchesCurrentHead: false,
      readyToMerge: false,
    });

    await expect(
      service.decide({
        repoPath: repo,
        runId: String(started.runId),
        decision: "MERGE_APPROVED",
        rationale: "This must not be accepted after the head moved.",
        unresolvedP1: 0,
      }),
    ).rejects.toThrow(/STALE/);
  });

  it("rejects approval while a blocking P1 remains", async () => {
    const { repo } = await fixture();
    const service = new MergeAuditService();
    const started = await service.start({
      repoPath: repo,
      baseBranch: "main",
      headBranch: "feature/audit",
    });

    await expect(
      service.decide({
        repoPath: repo,
        runId: String(started.runId),
        decision: "MERGE_APPROVED",
        rationale: "Attempted approval despite a blocker.",
        unresolvedP1: 1,
      }),
    ).rejects.toThrow(/unresolvedP1/);
  });
});
