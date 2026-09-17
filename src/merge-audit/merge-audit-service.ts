import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { MergeAuditDecision, MergeAuditManifest } from "./merge-audit-types.js";

const execFileAsync = promisify(execFile);
const MAX_DIFF_CHARS = 240_000;

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "detached";
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("runId contains unsupported characters");
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export class MergeAuditService {
  readonly #stateRoot?: string;

  constructor(options: { stateRoot?: string } = {}) {
    this.#stateRoot = options.stateRoot ? path.resolve(options.stateRoot) : undefined;
  }

  #auditRoot(repoRoot: string): string {
    return this.#stateRoot ?? path.join(repoRoot, ".moon", "merge-audits");
  }

  async #git(repoPath: string, args: string[]): Promise<string> {
    const result = await execFileAsync("git", ["-C", repoPath, ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return String(result.stdout).trimEnd();
  }

  async #repoRoot(repoPath: string): Promise<string> {
    const root = await this.#git(repoPath, ["rev-parse", "--show-toplevel"]);
    if (!root) throw new Error(`Not a Git repository: ${repoPath}`);
    return path.resolve(root);
  }

  async #findRunDir(repoRoot: string, runId: string): Promise<string> {
    assertRunId(runId);
    const root = this.#auditRoot(repoRoot);
    const branches = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const branch of branches) {
      if (!branch.isDirectory()) continue;
      const candidate = path.join(root, branch.name, runId);
      if (await exists(path.join(candidate, "manifest.json"))) return candidate;
    }
    throw new Error(`Unknown merge audit run: ${runId}`);
  }

  async #readManifest(repoRoot: string, runId: string): Promise<MergeAuditManifest> {
    const runDir = await this.#findRunDir(repoRoot, runId);
    return JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")) as MergeAuditManifest;
  }

  async #writeManifest(manifest: MergeAuditManifest): Promise<void> {
    manifest.updatedAt = new Date().toISOString();
    await writeFile(
      path.join(manifest.artifactDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }

  async start(input: {
    repoPath: string;
    baseBranch?: string;
    headBranch: string;
    request?: string;
    internalAuditSummary?: string;
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.#repoRoot(input.repoPath);
    const baseBranch = input.baseBranch?.trim() || "main";
    const headBranch = input.headBranch.trim();
    if (!headBranch) throw new Error("headBranch is required for an independent merge audit");

    await this.#git(repoRoot, ["rev-parse", "--verify", `${baseBranch}^{commit}`]);
    await this.#git(repoRoot, ["rev-parse", "--verify", `${headBranch}^{commit}`]);

    const baseSha = await this.#git(repoRoot, ["rev-parse", baseBranch]);
    const headSha = await this.#git(repoRoot, ["rev-parse", headBranch]);
    const mergeBase = await this.#git(repoRoot, ["merge-base", baseSha, headSha]);
    const changedFilesRaw = await this.#git(repoRoot, ["diff", "--name-only", `${mergeBase}..${headSha}`]);
    const changedFiles = changedFilesRaw ? changedFilesRaw.split("\n").filter(Boolean) : [];
    const diffStat = await this.#git(repoRoot, ["diff", "--stat", `${mergeBase}..${headSha}`]);

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const runId = `${stamp}-${headSha.slice(0, 8)}-${randomBytes(2).toString("hex")}`;
    const artifactDir = path.join(
      this.#auditRoot(repoRoot),
      safeSegment(headBranch),
      runId,
    );
    await mkdir(artifactDir, { recursive: true });

    const now = new Date().toISOString();
    const manifest: MergeAuditManifest = {
      schemaVersion: 1,
      runId,
      repoRoot,
      baseBranch,
      headBranch,
      baseSha,
      headSha,
      mergeBase,
      request: input.request?.trim() || undefined,
      internalAuditSummary: input.internalAuditSummary?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
      state: "INPUT_PINNED",
      changedFiles,
      diffStat,
      artifactDir,
    };
    await this.#writeManifest(manifest);

    return {
      runId,
      state: manifest.state,
      baseBranch,
      headBranch,
      baseSha,
      headSha,
      mergeBase,
      changedFiles,
      diffStat,
      artifactDir,
    };
  }

  async context(input: { repoPath: string; runId: string }): Promise<Record<string, unknown>> {
    const repoRoot = await this.#repoRoot(input.repoPath);
    const manifest = await this.#readManifest(repoRoot, input.runId);
    const currentHeadSha = await this.#git(repoRoot, ["rev-parse", manifest.headBranch]);
    const stale = currentHeadSha !== manifest.headSha;
    const rawDiff = await this.#git(repoRoot, [
      "diff",
      "--find-renames",
      "--find-copies",
      `${manifest.mergeBase}..${manifest.headSha}`,
    ]);
    const diffTruncated = rawDiff.length > MAX_DIFF_CHARS;
    const diff = diffTruncated
      ? `${rawDiff.slice(0, MAX_DIFF_CHARS)}\n\n[truncated by Project Moon]`
      : rawDiff;

    return {
      runId: manifest.runId,
      state: manifest.state,
      pinnedHeadSha: manifest.headSha,
      currentHeadSha,
      stale,
      request: manifest.request,
      internalAuditSummary: manifest.internalAuditSummary,
      changedFiles: manifest.changedFiles,
      diffStat: manifest.diffStat,
      diff,
      diffTruncated,
      auditorContract:
        "Independently decide whether the pinned commit is safe to merge into the base branch. Treat internal audit output only as evidence, never as an approval. Do not modify code. Cite concrete evidence for the decision.",
    };
  }

  async decide(input: {
    repoPath: string;
    runId: string;
    decision: MergeAuditDecision;
    rationale: string;
    unresolvedP1?: number;
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.#repoRoot(input.repoPath);
    const manifest = await this.#readManifest(repoRoot, input.runId);
    const currentHeadSha = await this.#git(repoRoot, ["rev-parse", manifest.headBranch]);
    if (currentHeadSha !== manifest.headSha) {
      throw new Error("Merge audit is STALE because the reviewed head branch moved");
    }

    const unresolvedP1 = input.unresolvedP1 ?? 0;
    if (!Number.isInteger(unresolvedP1) || unresolvedP1 < 0) {
      throw new Error("unresolvedP1 must be a non-negative integer");
    }
    if (input.decision === "MERGE_APPROVED" && unresolvedP1 !== 0) {
      throw new Error("MERGE_APPROVED requires unresolvedP1 to be zero");
    }
    if (!input.rationale.trim()) throw new Error("A merge audit decision requires rationale");

    manifest.decision = input.decision;
    manifest.rationale = input.rationale.trim();
    manifest.unresolvedP1 = unresolvedP1;
    manifest.state = input.decision;
    manifest.approvalSha = input.decision === "MERGE_APPROVED" ? manifest.headSha : undefined;
    await this.#writeManifest(manifest);
    await writeFile(
      path.join(manifest.artifactDir, "decision.md"),
      `# Merge Audit Decision\n\nDecision: ${input.decision}\nAudited SHA: ${manifest.headSha}\nUnresolved P1: ${unresolvedP1}\n\n${manifest.rationale}\n`,
      "utf8",
    );

    return {
      runId: manifest.runId,
      decision: manifest.decision,
      approvalSha: manifest.approvalSha,
      unresolvedP1,
      readyToMerge: input.decision === "MERGE_APPROVED",
    };
  }

  async status(input: { repoPath: string; runId: string }): Promise<Record<string, unknown>> {
    const repoRoot = await this.#repoRoot(input.repoPath);
    const manifest = await this.#readManifest(repoRoot, input.runId);
    const currentHeadSha = await this.#git(repoRoot, ["rev-parse", manifest.headBranch]);
    const stale = currentHeadSha !== manifest.headSha;
    const approvalMatchesCurrentHead =
      typeof manifest.approvalSha === "string" && manifest.approvalSha === currentHeadSha;
    const readyToMerge =
      manifest.decision === "MERGE_APPROVED" &&
      manifest.unresolvedP1 === 0 &&
      approvalMatchesCurrentHead &&
      !stale;

    return {
      ...manifest,
      currentHeadSha,
      stale,
      effectiveState: stale ? "STALE" : manifest.state,
      approvalMatchesCurrentHead,
      readyToMerge,
    };
  }
}
