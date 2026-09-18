import { describe, expect, it } from "vitest";

import { GitHubCliMergeExecutor } from "../src/github/github-cli-merge-executor.js";

function fixture(options: {
  auditor?: string;
  author?: string;
  headSha?: string;
  reviewDecision?: string;
  mergeStateStatus?: string;
  auditorApproved?: boolean;
  checkStatus?: string;
  checkConclusion?: string;
  expectedAuditorLogin?: string;
} = {}) {
  const calls: string[][] = [];
  const auditor = options.auditor ?? "moon-auditor";
  const author = options.author ?? "developer-main";
  const headSha = options.headSha ?? "a".repeat(40);
  let merged = false;

  const command = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "user") {
      return JSON.stringify({ login: auditor });
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (merged) {
        return JSON.stringify({
          state: "MERGED",
          mergedAt: "2026-09-18T00:00:00Z",
          mergedBy: { login: auditor },
          mergeCommit: { oid: "b".repeat(40) },
        });
      }
      return JSON.stringify({
        headRefOid: headSha,
        state: "OPEN",
        isDraft: false,
        author: { login: author },
        reviewDecision: options.reviewDecision ?? "APPROVED",
        mergeStateStatus: options.mergeStateStatus ?? "CLEAN",
        latestReviews: [
          {
            author: { login: options.auditorApproved === false ? "someone-else" : auditor },
            state: "APPROVED",
          },
        ],
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "validate",
            status: options.checkStatus ?? "COMPLETED",
            conclusion: options.checkConclusion ?? "SUCCESS",
          },
        ],
      });
    }
    if (args[0] === "pr" && args[1] === "merge") {
      merged = true;
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };

  return {
    calls,
    executor: new GitHubCliMergeExecutor({
      expectedAuditorLogin: options.expectedAuditorLogin ?? "moon-auditor",
      command,
    }),
    headSha,
  };
}

describe("GitHubCliMergeExecutor", () => {
  it("merges only the exact independently approved SHA", async () => {
    const { executor, calls, headSha } = fixture();

    const result = await executor.execute({
      repository: "kankinku/project-moon",
      pullNumber: 2,
      headSha,
    });

    expect(result).toMatchObject({
      auditor: "moon-auditor",
      headSha,
      mergeCommit: "b".repeat(40),
    });
    const merge = calls.find((args) => args[0] === "pr" && args[1] === "merge");
    expect(merge).toEqual([
      "pr",
      "merge",
      "2",
      "--repo",
      "kankinku/project-moon",
      "--merge",
      "--match-head-commit",
      headSha,
    ]);
  });

  it("rejects a stale GitHub PR head before merge", async () => {
    const { executor, calls } = fixture({ headSha: "b".repeat(40) });

    await expect(
      executor.execute({
        repository: "kankinku/project-moon",
        pullNumber: 2,
        headSha: "a".repeat(40),
      }),
    ).rejects.toThrow(/STALE/);

    expect(calls.some((args) => args[0] === "pr" && args[1] === "merge")).toBe(false);
  });

  it("requires an APPROVED review from the authenticated auditor account", async () => {
    const { executor, calls, headSha } = fixture({ auditorApproved: false });

    await expect(
      executor.execute({ repository: "kankinku/project-moon", pullNumber: 2, headSha }),
    ).rejects.toThrow(/has not published an APPROVED review/);

    expect(calls.some((args) => args[0] === "pr" && args[1] === "merge")).toBe(false);
  });

  it("rejects incomplete or failed CI evidence", async () => {
    const { executor, calls, headSha } = fixture({
      checkStatus: "COMPLETED",
      checkConclusion: "FAILURE",
    });

    await expect(
      executor.execute({ repository: "kankinku/project-moon", pullNumber: 2, headSha }),
    ).rejects.toThrow(/CI\/status checks are not successful/);

    expect(calls.some((args) => args[0] === "pr" && args[1] === "merge")).toBe(false);
  });

  it("rejects the wrong authenticated GitHub account", async () => {
    const { executor, calls, headSha } = fixture({
      auditor: "developer-main",
      expectedAuditorLogin: "moon-auditor",
    });

    await expect(
      executor.execute({ repository: "kankinku/project-moon", pullNumber: 2, headSha }),
    ).rejects.toThrow(/does not match expected merge auditor/);

    expect(calls.some((args) => args[0] === "pr" && args[1] === "merge")).toBe(false);
  });
});
