import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadHarnessConfig } from "../task/task-config.js";
import { classifyRisk } from "../task/task-risk.js";
import type {
  MergeAuditCategory,
  MergeAuditCoverage,
  MergeAuditDecision,
  MergeAuditFinding,
  MergeAuditManifest,
  MergeAuditValidationEvidence,
} from "./merge-audit-types.js";

const execFileAsync = promisify(execFile);
const MAX_DIFF_CHARS = 240_000;
const MAX_POLICY_CHARS = 120_000;

export const REQUIRED_REVIEW_CATEGORIES: readonly MergeAuditCategory[] = [
  "requirements",
  "correctness",
  "code_quality",
  "tests",
  "regression",
  "architecture",
  "api_contracts",
  "security",
  "performance",
  "operations",
  "maintainability",
];

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "detached";
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("runId contains unsupported characters");
}

function parseRepository(value: string): string {
  const normalized = value.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new Error("repository must use owner/name format");
  }
  return normalized;
}

function bounded(value: string, maxChars: number): { content: string; truncated: boolean } {
  if (value.length <= maxChars) return { content: value, truncated: false };
  return {
    content: `${value.slice(0, maxChars)}\n\n[truncated by Project Moon]`,
    truncated: true,
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function assertFindings(findings: MergeAuditFinding[]): void {
  const ids = new Set<string>();
  for (const finding of findings) {
    if (!finding.id.trim()) throw new Error("Every merge-audit finding requires a non-empty id");
    if (ids.has(finding.id)) throw new Error(`Duplicate merge-audit finding id: ${finding.id}`);
    ids.add(finding.id);
    if (!finding.title.trim()) throw new Error(`Finding ${finding.id} requires a title`);
    if (!finding.evidence.trim()) throw new Error(`Finding ${finding.id} requires concrete evidence`);
    if (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line <= 0)) {
      throw new Error(`Finding ${finding.id} line must be a positive integer`);
    }
  }
}

function assertCoverage(coverage: MergeAuditCoverage[]): void {
  const byCategory = new Map<MergeAuditCategory, MergeAuditCoverage>();
  for (const item of coverage) {
    if (byCategory.has(item.category)) {
      throw new Error(`Duplicate merge-audit coverage category: ${item.category}`);
    }
    if (!item.evidence.trim()) {
      throw new Error(`Review coverage ${item.category} requires concrete evidence`);
    }
    byCategory.set(item.category, item);
  }
  const missing = REQUIRED_REVIEW_CATEGORIES.filter((category) => !byCategory.has(category));
  if (missing.length > 0) {
    throw new Error(`Full merge review is missing required categories: ${missing.join(", ")}`);
  }
}

function validationProfileSatisfied(
  evidence: MergeAuditValidationEvidence[],
  manifest: MergeAuditManifest,
): boolean {
  const requiredIndex = manifest.risk.validationProfileOrder.indexOf(
    manifest.risk.requiredValidationProfile,
  );
  if (requiredIndex < 0) return false;
  return evidence.some((item) => {
    const profileIndex = manifest.risk.validationProfileOrder.indexOf(item.profile);
    return (
      item.passed &&
      item.headSha === manifest.headSha &&
      profileIndex >= requiredIndex &&
      item.reference.trim().length > 0 &&
      item.summary.trim().length > 0
    );
  });
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

  async #gitFileAtRef(repoRoot: string, ref: string, relativePath: string): Promise<string | undefined> {
    try {
      return await this.#git(repoRoot, ["show", `${ref}:${relativePath}`]);
    } catch {
      return undefined;
    }
  }

  async #loadPinnedHarnessConfig(repoRoot: string, baseSha: string) {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "project-moon-merge-policy-"));
    try {
      const moonConfig = await this.#gitFileAtRef(repoRoot, baseSha, "moon.config.json");
      if (moonConfig !== undefined) {
        await writeFile(path.join(tempRoot, "moon.config.json"), `${moonConfig}\n`, "utf8");
      } else {
        const packageJson = await this.#gitFileAtRef(repoRoot, baseSha, "package.json");
        if (packageJson !== undefined) {
          await writeFile(path.join(tempRoot, "package.json"), `${packageJson}\n`, "utf8");
        }
      }
      return await loadHarnessConfig(tempRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
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
    const raw = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")) as {
      schemaVersion?: unknown;
      target?: unknown;
      risk?: unknown;
    };
    if (raw.schemaVersion !== 2 || raw.target === undefined || raw.risk === undefined) {
      throw new Error(
        "Legacy merge audit run is incompatible with the full-review gate. Start a fresh audit for the current repository/PR/base/head.",
      );
    }
    return raw as MergeAuditManifest;
  }

  async #writeManifest(manifest: MergeAuditManifest): Promise<void> {
    manifest.updatedAt = new Date().toISOString();
    await writeFile(
      path.join(manifest.artifactDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }

  async #currentPins(repoRoot: string, manifest: MergeAuditManifest): Promise<{
    currentBaseSha: string;
    currentHeadSha: string;
    baseStale: boolean;
    headStale: boolean;
    stale: boolean;
  }> {
    const [currentBaseSha, currentHeadSha] = await Promise.all([
      this.#git(repoRoot, ["rev-parse", manifest.baseBranch]),
      this.#git(repoRoot, ["rev-parse", manifest.headBranch]),
    ]);
    const baseStale = currentBaseSha !== manifest.baseSha;
    const headStale = currentHeadSha !== manifest.headSha;
    return {
      currentBaseSha,
      currentHeadSha,
      baseStale,
      headStale,
      stale: baseStale || headStale,
    };
  }

  async start(input: {
    repoPath: string;
    repository: string;
    pullNumber: number;
    baseBranch?: string;
    headBranch: string;
    request?: string;
    internalAuditSummary?: string;
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.#repoRoot(input.repoPath);
    const repository = parseRepository(input.repository);
    if (!Number.isInteger(input.pullNumber) || input.pullNumber <= 0) {
      throw new Error("pullNumber must be a positive integer");
    }
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

    const { config } = await this.#loadPinnedHarnessConfig(repoRoot, baseSha);
    const riskAssessment = classifyRisk(config, input.request?.trim() || "", changedFiles);
    const requiredValidationProfile = config.validation.riskProfiles[riskAssessment.level];

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const runId = `${stamp}-${headSha.slice(0, 8)}-${randomBytes(2).toString("hex")}`;
    const artifactDir = path.join(this.#auditRoot(repoRoot), safeSegment(headBranch), runId);
    await mkdir(artifactDir, { recursive: true });

    const now = new Date().toISOString();
    const manifest: MergeAuditManifest = {
      schemaVersion: 2,
      runId,
      repoRoot,
      target: { repository, pullNumber: input.pullNumber },
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
      risk: {
        level: riskAssessment.level,
        reasons: riskAssessment.reasons,
        requiredValidationProfile,
        validationProfileOrder: [...config.validation.profileOrder],
      },
      changedFiles,
      diffStat,
      artifactDir,
    };
    await this.#writeManifest(manifest);

    return {
      runId,
      state: manifest.state,
      target: manifest.target,
      baseBranch,
      headBranch,
      baseSha,
      headSha,
      mergeBase,
      risk: manifest.risk,
      changedFiles,
      diffStat,
      artifactDir,
    };
  }

  async context(input: { repoPath: string; runId: string }): Promise<Record<string, unknown>> {
    const repoRoot = await this.#repoRoot(input.repoPath);
    const manifest = await this.#readManifest(repoRoot, input.runId);
    const pins = await this.#currentPins(repoRoot, manifest);
    const rawDiff = await this.#git(repoRoot, [
      "diff",
      "--find-renames",
      "--find-copies",
      `${manifest.mergeBase}..${manifest.headSha}`,
    ]);
    const diffValue = bounded(rawDiff, MAX_DIFF_CHARS);

    const readPolicy = async (relative: string) => {
      const content = await this.#gitFileAtRef(repoRoot, manifest.baseSha, relative);
      if (content === undefined) return { exists: false, content: "", truncated: false };
      const value = bounded(content, MAX_POLICY_CHARS);
      return { exists: true, ...value };
    };

    return {
      runId: manifest.runId,
      state: manifest.state,
      target: manifest.target,
      pinnedBaseSha: manifest.baseSha,
      currentBaseSha: pins.currentBaseSha,
      baseStale: pins.baseStale,
      pinnedHeadSha: manifest.headSha,
      currentHeadSha: pins.currentHeadSha,
      headStale: pins.headStale,
      stale: pins.stale,
      request: manifest.request,
      internalAuditSummary: manifest.internalAuditSummary,
      risk: manifest.risk,
      changedFiles: manifest.changedFiles,
      diffStat: manifest.diffStat,
      diff: diffValue.content,
      diffTruncated: diffValue.truncated,
      requiredReviewCategories: REQUIRED_REVIEW_CATEGORIES,
      policySourceSha: manifest.baseSha,
      policies: {
        agents: await readPolicy("AGENTS.md"),
        codeConvention: await readPolicy("docs/code-convention.yaml"),
        adr: await readPolicy("docs/adr.yaml"),
        moonConfig: await readPolicy("moon.config.json"),
      },
      auditorContract:
        "Perform a full independent final review of the pinned change. Verify requirements, correctness, code quality, tests, regression risk, architecture, API contracts, security, performance, operations, and maintainability. Internal review is evidence only. Record concrete P1-P4 findings and category-by-category evidence. Do not modify or execute repository code in this credential-bearing auditor runtime. MERGE_APPROVED requires complete review coverage, zero unresolved P1 findings, sufficient passing validation evidence bound to the pinned head SHA, and unchanged base/head pins.",
    };
  }

  async decide(input: {
    repoPath: string;
    runId: string;
    decision: MergeAuditDecision;
    rationale: string;
    findings: MergeAuditFinding[];
    coverage: MergeAuditCoverage[];
    validationEvidence: MergeAuditValidationEvidence[];
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.#repoRoot(input.repoPath);
    const manifest = await this.#readManifest(repoRoot, input.runId);
    const pins = await this.#currentPins(repoRoot, manifest);
    if (pins.stale) {
      throw new Error(
        `Merge audit is STALE because ${pins.baseStale ? "the base branch moved" : "the reviewed head branch moved"}`,
      );
    }
    if (!input.rationale.trim()) throw new Error("A merge audit decision requires rationale");

    assertFindings(input.findings);
    assertCoverage(input.coverage);
    for (const evidence of input.validationEvidence) {
      if (!evidence.profile.trim()) throw new Error("Validation evidence requires a profile");
      if (!/^[0-9a-f]{40}$/i.test(evidence.headSha)) {
        throw new Error("Validation evidence headSha must be a full 40-character Git commit SHA");
      }
      if (!evidence.reference.trim() || !evidence.summary.trim()) {
        throw new Error("Validation evidence requires reference and summary");
      }
    }

    const unresolvedP1 = input.findings.filter(
      (finding) => finding.severity === "P1" && !finding.resolved,
    ).length;
    const concernCategories = input.coverage
      .filter((item) => item.verdict === "CONCERN")
      .map((item) => item.category);
    const validationSatisfied = validationProfileSatisfied(input.validationEvidence, manifest);

    if (input.decision === "MERGE_APPROVED") {
      if (unresolvedP1 !== 0) {
        throw new Error("MERGE_APPROVED requires zero unresolved P1 findings");
      }
      if (concernCategories.length > 0) {
        throw new Error(
          `MERGE_APPROVED requires all review categories to pass or be explicitly not applicable: ${concernCategories.join(", ")}`,
        );
      }
      if (!validationSatisfied) {
        throw new Error(
          `MERGE_APPROVED requires passing validation evidence at profile ${manifest.risk.requiredValidationProfile} or stronger for the audited head SHA`,
        );
      }
    }

    manifest.decision = input.decision;
    manifest.rationale = input.rationale.trim();
    manifest.unresolvedP1 = unresolvedP1;
    manifest.findings = input.findings;
    manifest.coverage = input.coverage;
    manifest.validationEvidence = input.validationEvidence;
    manifest.state = input.decision;
    manifest.approvalSha = input.decision === "MERGE_APPROVED" ? manifest.headSha : undefined;
    await this.#writeManifest(manifest);

    await writeFile(
      path.join(manifest.artifactDir, "review.json"),
      `${JSON.stringify(
        {
          target: manifest.target,
          risk: manifest.risk,
          findings: input.findings,
          coverage: input.coverage,
          validationEvidence: input.validationEvidence,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      path.join(manifest.artifactDir, "decision.md"),
      [
        "# Merge Audit Decision",
        "",
        `Decision: ${input.decision}`,
        `Repository: ${manifest.target.repository}`,
        `Pull request: #${manifest.target.pullNumber}`,
        `Base SHA: ${manifest.baseSha}`,
        `Audited SHA: ${manifest.headSha}`,
        `Risk: ${manifest.risk.level}`,
        `Required validation: ${manifest.risk.requiredValidationProfile}`,
        `Unresolved P1: ${unresolvedP1}`,
        "",
        manifest.rationale,
        "",
      ].join("\n"),
      "utf8",
    );

    return {
      runId: manifest.runId,
      decision: manifest.decision,
      approvalSha: manifest.approvalSha,
      unresolvedP1,
      concernCategories,
      validationSatisfied,
      readyToMerge: input.decision === "MERGE_APPROVED",
    };
  }

  async status(input: { repoPath: string; runId: string }): Promise<Record<string, unknown>> {
    const repoRoot = await this.#repoRoot(input.repoPath);
    const manifest = await this.#readManifest(repoRoot, input.runId);
    const pins = await this.#currentPins(repoRoot, manifest);
    const approvalMatchesCurrentHead =
      typeof manifest.approvalSha === "string" && manifest.approvalSha === pins.currentHeadSha;
    const concernCategories =
      manifest.coverage?.filter((item) => item.verdict === "CONCERN").map((item) => item.category) ?? [];
    const coverageComplete =
      manifest.coverage !== undefined &&
      REQUIRED_REVIEW_CATEGORIES.every((category) =>
        manifest.coverage!.some((item) => item.category === category),
      );
    const validationSatisfied = validationProfileSatisfied(manifest.validationEvidence ?? [], manifest);
    const qualityGateSatisfied =
      coverageComplete &&
      concernCategories.length === 0 &&
      manifest.unresolvedP1 === 0 &&
      validationSatisfied;
    const readyToMerge =
      manifest.decision === "MERGE_APPROVED" &&
      approvalMatchesCurrentHead &&
      !pins.stale &&
      qualityGateSatisfied;

    return {
      ...manifest,
      ...pins,
      effectiveState: pins.stale ? "STALE" : manifest.state,
      approvalMatchesCurrentHead,
      coverageComplete,
      concernCategories,
      validationSatisfied,
      qualityGateSatisfied,
      readyToMerge,
    };
  }
}
