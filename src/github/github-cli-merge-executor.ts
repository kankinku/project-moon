import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type GhCommand = (args: string[]) => Promise<string>;

interface UserInfo {
  login?: string;
}

interface PullApiInfo {
  state?: string;
  draft?: boolean;
  user?: { login?: string };
  head?: { sha?: string };
  base?: { ref?: string; sha?: string };
}

interface CheckRun {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string;
  context?: string;
  state?: string;
}

interface PullInfo {
  reviewDecision?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: CheckRun[];
  latestReviews?: Array<{ author?: { login?: string }; state?: string }>;
  state?: string;
  mergedAt?: string;
  mergedBy?: { login?: string };
  mergeCommit?: { oid?: string };
}

export interface ExecuteAuditedMergeInput {
  repository: string;
  pullNumber: number;
  headSha: string;
  baseBranch: string;
  baseSha: string;
}

export interface ExecuteAuditedMergeResult extends Record<string, unknown> {
  repository: string;
  pullNumber: number;
  auditor: string;
  headSha: string;
  baseBranch: string;
  baseSha: string;
  mergeCommit: string;
  mergedAt: string;
}

function parseRepository(value: string): string {
  const normalized = value.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new Error("repository must use owner/name format");
  }
  return normalized;
}

function checkName(check: CheckRun): string {
  return check.name?.trim() || check.context?.trim() || "unknown";
}

function checkSucceeded(check: CheckRun): boolean {
  if (check.status) {
    if (check.status !== "COMPLETED") return false;
    return ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? "");
  }
  if (check.state) return check.state === "SUCCESS";
  return false;
}

export class GitHubCliMergeExecutor {
  readonly #expectedAuditorLogin?: string;
  readonly #gh: GhCommand;

  constructor(options: {
    expectedAuditorLogin?: string;
    ghBinary?: string;
    command?: GhCommand;
  } = {}) {
    this.#expectedAuditorLogin = options.expectedAuditorLogin?.trim().toLowerCase() || undefined;
    const ghBinary = options.ghBinary?.trim() || "gh";
    this.#gh =
      options.command ??
      (async (args) => {
        const result = await execFileAsync(ghBinary, args, {
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, GH_PROMPT_DISABLED: "1" },
        });
        return String(result.stdout).trim();
      });
  }

  async #json<T>(args: string[]): Promise<T> {
    const output = await this.#gh(args);
    return JSON.parse(output) as T;
  }

  async execute(input: ExecuteAuditedMergeInput): Promise<ExecuteAuditedMergeResult> {
    const repository = parseRepository(input.repository);
    if (!Number.isInteger(input.pullNumber) || input.pullNumber <= 0) {
      throw new Error("pullNumber must be a positive integer");
    }
    if (!/^[0-9a-f]{40}$/i.test(input.headSha) || !/^[0-9a-f]{40}$/i.test(input.baseSha)) {
      throw new Error("headSha and baseSha must be full 40-character Git commit SHAs");
    }
    const baseBranch = input.baseBranch.trim();
    if (!baseBranch) throw new Error("baseBranch is required");

    const user = await this.#json<UserInfo>(["api", "user"]);
    const auditor = user.login?.trim();
    if (!auditor) throw new Error("Unable to resolve the GitHub account authenticated in gh CLI");
    if (this.#expectedAuditorLogin && auditor.toLowerCase() !== this.#expectedAuditorLogin) {
      throw new Error(
        `Authenticated gh account ${auditor} does not match expected merge auditor ${this.#expectedAuditorLogin}`,
      );
    }

    const pullTarget = await this.#json<PullApiInfo>([
      "api",
      `repos/${repository}/pulls/${input.pullNumber}`,
    ]);
    const author = pullTarget.user?.login?.trim();
    if (!author) throw new Error("Unable to resolve pull request author");
    if (auditor.toLowerCase() === author.toLowerCase()) {
      throw new Error("Merge auditor account must be different from the pull request author");
    }
    if (pullTarget.state?.toLowerCase() !== "open") {
      throw new Error(`Pull request is not open: ${pullTarget.state ?? "unknown"}`);
    }
    if (pullTarget.draft === true) throw new Error("Draft pull requests cannot be merged");
    if (pullTarget.base?.ref !== baseBranch || pullTarget.base?.sha !== input.baseSha) {
      throw new Error(
        `Merge audit is STALE: GitHub PR base ${pullTarget.base?.ref ?? "unknown"}@${pullTarget.base?.sha ?? "unknown"} does not match audited base ${baseBranch}@${input.baseSha}`,
      );
    }
    if (pullTarget.head?.sha !== input.headSha) {
      throw new Error(
        `Merge audit is STALE: GitHub PR head ${pullTarget.head?.sha ?? "unknown"} does not match audited SHA ${input.headSha}`,
      );
    }

    const pull = await this.#json<PullInfo>([
      "pr",
      "view",
      String(input.pullNumber),
      "--repo",
      repository,
      "--json",
      "reviewDecision,mergeStateStatus,statusCheckRollup,latestReviews",
    ]);
    if (pull.reviewDecision !== "APPROVED") {
      throw new Error(`Pull request review decision is not APPROVED: ${pull.reviewDecision ?? "unknown"}`);
    }
    const auditorApproved = (pull.latestReviews ?? []).some(
      (review) =>
        review.state === "APPROVED" &&
        review.author?.login?.trim().toLowerCase() === auditor.toLowerCase(),
    );
    if (!auditorApproved) {
      throw new Error("Authenticated merge auditor has not published an APPROVED review for this PR");
    }
    if (pull.mergeStateStatus !== "CLEAN") {
      throw new Error(`Pull request merge state is not CLEAN: ${pull.mergeStateStatus ?? "unknown"}`);
    }

    const checks = pull.statusCheckRollup ?? [];
    if (checks.length === 0) {
      throw new Error("Pull request has no CI/status-check evidence");
    }
    const failedChecks = checks.filter((check) => !checkSucceeded(check)).map(checkName);
    if (failedChecks.length > 0) {
      throw new Error(`Pull request CI/status checks are not successful: ${failedChecks.join(", ")}`);
    }

    await this.#gh([
      "pr",
      "merge",
      String(input.pullNumber),
      "--repo",
      repository,
      "--merge",
      "--match-head-commit",
      input.headSha,
    ]);

    const merged = await this.#json<PullInfo>([
      "pr",
      "view",
      String(input.pullNumber),
      "--repo",
      repository,
      "--json",
      "state,mergedAt,mergedBy,mergeCommit",
    ]);
    if (merged.state !== "MERGED") throw new Error("GitHub did not report the pull request as MERGED");
    const mergedBy = merged.mergedBy?.login?.trim();
    if (!mergedBy || mergedBy.toLowerCase() !== auditor.toLowerCase()) {
      throw new Error("Merged pull request was not attributed to the authenticated auditor account");
    }
    const mergeCommit = merged.mergeCommit?.oid?.trim();
    const mergedAt = merged.mergedAt?.trim();
    if (!mergeCommit || !mergedAt) throw new Error("GitHub merge result is missing merge commit metadata");

    return {
      repository,
      pullNumber: input.pullNumber,
      auditor,
      headSha: input.headSha,
      baseBranch,
      baseSha: input.baseSha,
      mergeCommit,
      mergedAt,
    };
  }
}
