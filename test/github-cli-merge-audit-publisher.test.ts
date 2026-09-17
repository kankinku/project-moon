import { describe, expect, it } from "vitest";

import { GitHubCliMergeAuditPublisher } from "../src/github/github-cli-merge-audit-publisher.js";

function publisherFixture(options: {
  auditor?: string;
  author?: string;
  headSha?: string;
  expectedAuditorLogin?: string;
}) {
  const calls: string[][] = [];
  const auditor = options.auditor ?? "moon-auditor";
  const author = options.author ?? "developer-main";
  const headSha = options.headSha ?? "a".repeat(40);
  const command = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "user") {
      return JSON.stringify({ login: auditor });
    }
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({
        headRefOid: headSha,
        state: "OPEN",
        isDraft: false,
        author: { login: author },
      });
    }
    if (args[0] === "pr" && args[1] === "review") return "";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return {
    calls,
    publisher: new GitHubCliMergeAuditPublisher({
      expectedAuditorLogin: options.expectedAuditorLogin,
      command,
    }),
    headSha,
  };
}

describe("GitHubCliMergeAuditPublisher", () => {
  it("publishes approval from the dedicated secondary account", async () => {
    const { publisher, calls, headSha } = publisherFixture({
      expectedAuditorLogin: "moon-auditor",
    });

    const result = await publisher.publish({
      repository: "kankinku/project-moon",
      pullNumber: 5,
      runId: "audit-001",
      headSha,
      decision: "MERGE_APPROVED",
      rationale: "독립적으로 diff와 검증 증거를 확인했고 차단 문제가 없다.",
      unresolvedP1: 0,
    });

    expect(result).toMatchObject({
      auditor: "moon-auditor",
      author: "developer-main",
      headSha,
      decision: "MERGE_APPROVED",
      reviewEvent: "APPROVE",
    });
    const review = calls.find((args) => args[0] === "pr" && args[1] === "review");
    expect(review).toContain("--approve");
    expect(review).toContain("--body");
    expect(review?.join(" ")).toContain(headSha);
  });

  it("uses REQUEST_CHANGES for blocked decisions", async () => {
    const { publisher, calls, headSha } = publisherFixture({});

    await publisher.publish({
      repository: "kankinku/project-moon",
      pullNumber: 5,
      runId: "audit-002",
      headSha,
      decision: "BLOCKED",
      rationale: "필수 검증 증거가 없다.",
      unresolvedP1: 1,
    });

    const review = calls.find((args) => args[0] === "pr" && args[1] === "review");
    expect(review).toContain("--request-changes");
  });

  it("rejects the wrong authenticated gh account", async () => {
    const { publisher, headSha } = publisherFixture({
      auditor: "developer-main",
      expectedAuditorLogin: "moon-auditor",
    });

    await expect(
      publisher.publish({
        repository: "kankinku/project-moon",
        pullNumber: 5,
        runId: "audit-003",
        headSha,
        decision: "MERGE_APPROVED",
        rationale: "should not publish",
        unresolvedP1: 0,
      }),
    ).rejects.toThrow(/does not match expected merge auditor/);
  });

  it("rejects self-review when auditor and PR author are the same account", async () => {
    const { publisher, headSha } = publisherFixture({
      auditor: "same-user",
      author: "same-user",
    });

    await expect(
      publisher.publish({
        repository: "kankinku/project-moon",
        pullNumber: 5,
        runId: "audit-004",
        headSha,
        decision: "MERGE_APPROVED",
        rationale: "should not publish",
        unresolvedP1: 0,
      }),
    ).rejects.toThrow(/different from the pull request author/);
  });

  it("rejects publication when GitHub PR head moved after the audit", async () => {
    const { publisher } = publisherFixture({ headSha: "b".repeat(40) });

    await expect(
      publisher.publish({
        repository: "kankinku/project-moon",
        pullNumber: 5,
        runId: "audit-005",
        headSha: "a".repeat(40),
        decision: "MERGE_APPROVED",
        rationale: "stale",
        unresolvedP1: 0,
      }),
    ).rejects.toThrow(/STALE/);
  });
});
