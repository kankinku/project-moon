import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MergeAuditDecision } from "../merge-audit/merge-audit-types.js";

const execFileAsync = promisify(execFile);

type GhCommand = (args: string[]) => Promise<string>;

export interface PublishMergeAuditInput {
  repository: string;
  pullNumber: number;
  runId: string;
  headSha: string;
  decision: MergeAuditDecision;
  rationale: string;
  unresolvedP1: number;
}

export interface PublishMergeAuditResult extends Record<string, unknown> {
  repository: string;
  pullNumber: number;
  auditor: string;
  author: string;
  headSha: string;
  decision: MergeAuditDecision;
  reviewEvent: "APPROVE" | "REQUEST_CHANGES";
}

interface PullInfo {
  headRefOid?: string;
  state?: string;
  isDraft?: boolean;
  author?: { login?: string };
}

interface UserInfo {
  login?: string;
}

function parseRepository(value: string): string {
  const normalized = value.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new Error("repository must use owner/name format");
  }
  return normalized;
}

export class GitHubCliMergeAuditPublisher {
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

  async publish(input: PublishMergeAuditInput): Promise<PublishMergeAuditResult> {
    const repository = parseRepository(input.repository);
    if (!Number.isInteger(input.pullNumber) || input.pullNumber <= 0) {
      throw new Error("pullNumber must be a positive integer");
    }
    if (!/^[0-9a-f]{40}$/i.test(input.headSha)) {
      throw new Error("headSha must be a full 40-character Git commit SHA");
    }
    if (!input.rationale.trim()) throw new Error("rationale is required");
    if (!Number.isInteger(input.unresolvedP1) || input.unresolvedP1 < 0) {
      throw new Error("unresolvedP1 must be a non-negative integer");
    }
    if (input.decision === "MERGE_APPROVED" && input.unresolvedP1 !== 0) {
      throw new Error("MERGE_APPROVED cannot be published while unresolved P1 findings remain");
    }

    const user = await this.#json<UserInfo>(["api", "user"]);
    const auditor = user.login?.trim();
    if (!auditor) throw new Error("Unable to resolve the GitHub account authenticated in gh CLI");
    if (this.#expectedAuditorLogin && auditor.toLowerCase() !== this.#expectedAuditorLogin) {
      throw new Error(
        `Authenticated gh account ${auditor} does not match expected merge auditor ${this.#expectedAuditorLogin}`,
      );
    }

    const pull = await this.#json<PullInfo>([
      "pr",
      "view",
      String(input.pullNumber),
      "--repo",
      repository,
      "--json",
      "headRefOid,state,isDraft,author",
    ]);
    const author = pull.author?.login?.trim();
    if (!author) throw new Error("Unable to resolve pull request author");
    if (auditor.toLowerCase() === author.toLowerCase()) {
      throw new Error("Merge auditor account must be different from the pull request author");
    }
    if (pull.state !== "OPEN") throw new Error(`Pull request is not open: ${pull.state ?? "unknown"}`);
    if (pull.isDraft === true) throw new Error("Draft pull requests cannot receive final merge approval");
    if (pull.headRefOid !== input.headSha) {
      throw new Error(
        `Merge audit is STALE: GitHub PR head ${pull.headRefOid ?? "unknown"} does not match audited SHA ${input.headSha}`,
      );
    }

    const reviewEvent = input.decision === "MERGE_APPROVED" ? "APPROVE" : "REQUEST_CHANGES";
    const body = [
      "## Moon Independent Merge Audit",
      "",
      `Decision: **${input.decision}**`,
      `Auditor: **@${auditor}**`,
      `Audited SHA: \`${input.headSha}\``,
      `Unresolved P1: **${input.unresolvedP1}**`,
      `Audit run: \`${input.runId}\``,
      "",
      "### 판단 근거",
      "",
      input.rationale.trim(),
      "",
      "이 판단은 위 SHA에만 유효합니다. PR head SHA가 변경되면 재감사가 필요합니다.",
    ].join("\n");

    const args = ["pr", "review", String(input.pullNumber), "--repo", repository];
    args.push(reviewEvent === "APPROVE" ? "--approve" : "--request-changes", "--body", body);
    await this.#gh(args);

    return {
      repository,
      pullNumber: input.pullNumber,
      auditor,
      author,
      headSha: input.headSha,
      decision: input.decision,
      reviewEvent,
    };
  }
}
