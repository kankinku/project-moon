import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  QaCommandResult,
  ReviewArtifactKind,
  ReviewManifest,
  ReviewState,
} from "./review-types.js";

const execFileAsync = promisify(execFile);
const MAX_CONTEXT_CHARS = 240_000;
const MAX_POLICY_CHARS = 160_000;
const MAX_QA_OUTPUT_CHARS = 120_000;

const ARTIFACT_FILES: Record<ReviewArtifactKind, string> = {
  design_intent: "design-intent.md",
  criteria: "code-quality-guide.md",
  pr_body: "pr-body.md",
  review: "review-comments.md",
  decisions: "decisions.md",
  final_report: "final-report.md",
};

const STAGE_PROMPTS = {
  intent:
    "Infer the implementation intent from the user request, pinned Git context, changed files, and diff. Record the problem, key design decisions, tradeoffs, explicitly excluded scope, and review-sensitive assumptions. Do not invent intent that is not supported by evidence.",
  criteria:
    "Build review criteria from the confirmed design intent plus only relevant project conventions and ADRs. Prefer enforceable criteria over stylistic preference. Identify conflicts between policy documents instead of silently choosing one.",
  review:
    "Review the pinned diff against design intent and code-quality criteria. Every finding must cite a concrete criterion, bug, security issue, test failure, or intent/implementation mismatch. Classify P1-P4, include file/line evidence, proposed change, side effects, and rationale.",
  fix:
    "Evaluate each review finding before changing code. Record ACCEPT or REJECT with evidence. Apply accepted fixes in the isolated worktree, run QA, then re-review changed code for regressions before declaring the run passed.",
} as const;

export type ReviewContextStage = keyof typeof STAGE_PROMPTS;

interface CommandResult {
  stdout: string;
  stderr: string;
}

function bounded(value: string, maxChars: number): { content: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { content: value, truncated: false };
  }
  return {
    content: `${value.slice(0, maxChars)}\n\n[truncated by Project Moon]`,
    truncated: true,
  };
}

function safeBranchSegment(branch: string): string {
  const normalized = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "detached";
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error("runId contains unsupported characters");
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export class ReviewService {
  async #command(
    executable: string,
    args: string[],
    options: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {},
  ): Promise<CommandResult> {
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  }

  async #git(repoPath: string, args: string[]): Promise<string> {
    const result = await this.#command("git", ["-C", repoPath, ...args]);
    return result.stdout.trimEnd();
  }

  async #repoRoot(repoPath: string): Promise<string> {
    const root = await this.#git(repoPath, ["rev-parse", "--show-toplevel"]);
    if (!root) {
      throw new Error(`Not a Git repository: ${repoPath}`);
    }
    return path.resolve(root);
  }

  async #ensureLocalIgnore(repoRoot: string): Promise<void> {
    const excludePath = (await this.#git(repoRoot, ["rev-parse", "--git-path", "info/exclude"])) || ".git/info/exclude";
    const absolute = path.isAbsolute(excludePath) ? excludePath : path.join(repoRoot, excludePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const current = (await exists(absolute)) ? await readFile(absolute, "utf8") : "";
    if (!current.split(/\r?\n/).includes(".moon/")) {
      await appendFile(absolute, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}.moon/\n`, "utf8");
    }
  }

  async #findRunDir(repoRoot: string, runId: string): Promise<string> {
    assertRunId(runId);
    const reviewsRoot = path.join(repoRoot, ".moon", "reviews");
    const branches = await readdir(reviewsRoot, { withFileTypes: true }).catch(() => []);
    for (const branch of branches) {
      if (!branch.isDirectory()) continue;
      const candidate = path.join(reviewsRoot, branch.name, runId);
      if (await exists(path.join(candidate, "manifest.json"))) return candidate;
    }
    throw new Error(`Unknown review run: ${runId}`);
  }

  async #readManifest(repoRoot: string, runId: string): Promise<ReviewManifest> {
    const runDir = await this.#findRunDir(repoRoot, runId);
    return JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")) as ReviewManifest;
  }

  async #writeManifest(manifest: ReviewManifest): Promise<void> {
    manifest.updatedAt = new Date().toISOString();
    await writeFile(
      path.join(manifest.artifactDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }

  async #invalidate(
    manifest: ReviewManifest,
    kinds: ReviewArtifactKind[],
    clearQa = false,
  ): Promise<void> {
    for (const kind of kinds) {
      const filename = manifest.artifacts[kind];
      if (filename) {
        await rm(path.join(manifest.artifactDir, filename), { force: true });
        delete manifest.artifacts[kind];
      }
    }
    if (clearQa) {
      await rm(path.join(manifest.artifactDir, "qa.json"), { force: true });
      delete manifest.qa;
    }
  }

  async start(input: {
    repoPath: string;
    baseBranch?: string;
    headBranch?: string;
    request?: string;
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.#repoRoot(input.repoPath);
    const baseBranch = input.baseBranch?.trim() || "main";
    const currentBranch = await this.#git(repoRoot, ["branch", "--show-current"]);
    const headBranch = input.headBranch?.trim() || currentBranch;
    if (!headBranch) throw new Error("A named head branch is required for review runs");

    await this.#git(repoRoot, ["rev-parse", "--verify", `${baseBranch}^{commit}`]);
    await this.#git(repoRoot, ["rev-parse", "--verify", `${headBranch}^{commit}`]);
    const status = await this.#git(repoRoot, ["status", "--porcelain=v1"]);
    const dirtyAtStart = status.length > 0;
    if (dirtyAtStart) {
      throw new Error("Review start requires a clean working tree so the pinned commit fully represents the reviewed code. Commit or stash changes first.");
    }

    const baseSha = await this.#git(repoRoot, ["rev-parse", baseBranch]);
    const headSha = await this.#git(repoRoot, ["rev-parse", headBranch]);
    const mergeBase = await this.#git(repoRoot, ["merge-base", baseSha, headSha]);
    const changedFilesRaw = await this.#git(repoRoot, ["diff", "--name-only", `${mergeBase}..${headSha}`]);
    const changedFiles = changedFilesRaw ? changedFilesRaw.split("\n").filter(Boolean) : [];
    const diffStat = await this.#git(repoRoot, ["diff", "--stat", `${mergeBase}..${headSha}`]);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const runId = `${stamp}-${headSha.slice(0, 8)}-${randomBytes(2).toString("hex")}`;
    const artifactDir = path.join(
      repoRoot,
      ".moon",
      "reviews",
      safeBranchSegment(headBranch),
      runId,
    );
    await mkdir(artifactDir, { recursive: true });
    await this.#ensureLocalIgnore(repoRoot);

    const now = new Date().toISOString();
    const manifest: ReviewManifest = {
      schemaVersion: 1,
      runId,
      repoRoot,
      baseBranch,
      headBranch,
      baseSha,
      headSha,
      mergeBase,
      createdAt: now,
      updatedAt: now,
      state: "CONTEXT_READY",
      dirtyAtStart,
      changedFiles,
      diffStat,
      artifactDir,
      artifacts: {},
    };
    await this.#writeManifest(manifest);
    if (input.request?.trim()) {
      await writeFile(path.join(artifactDir, "request.md"), `${input.request.trim()}\n`, "utf8");
    }
    return {
      runId,
      state: manifest.state,
      artifactDir,
      repoRoot,
      baseBranch,
      headBranch,
      baseSha,
      headSha,
      mergeBase,
      dirtyAtStart,
      changedFiles,
      diffStat,
    };
  }

  async context(input: {
    repoPath: string;
    runId: string;
    stage: ReviewContextStage;
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.#repoRoot(input.repoPath);
    const manifest = await this.#readManifest(repoRoot, input.runId);
    const currentHead = await this.#git(repoRoot, ["rev-parse", manifest.headBranch]);
    const stale = currentHead !== manifest.headSha;
    const diff = bounded(
      await this.#git(repoRoot, ["diff", "--find-renames", "--find-copies", `${manifest.mergeBase}..${manifest.headSha}`]),
      MAX_CONTEXT_CHARS,
    );
    const readOptional = async (filename: string, maxChars = MAX_POLICY_CHARS) => {
      const target = path.join(repoRoot, filename);
      if (!(await exists(target))) return { exists: false, content: "", truncated: false };
      const value = bounded(await readFile(target, "utf8"), maxChars);
      return { exists: true, ...value };
    };
    const artifact = async (kind: ReviewArtifactKind) => {
      const filename = manifest.artifacts[kind];
      if (!filename) return undefined;
      return readFile(path.join(manifest.artifactDir, filename), "utf8");
    };

    const common: Record<string, unknown> = {
      runId: manifest.runId,
      stage: input.stage,
      state: manifest.state,
      stale,
      pinnedHeadSha: manifest.headSha,
      currentHeadSha: currentHead,
      promptContract: STAGE_PROMPTS[input.stage],
      changedFiles: manifest.changedFiles,
      diffStat: manifest.diffStat,
      diff: diff.content,
      diffTruncated: diff.truncated,
      request: (await readOptional(path.relative(repoRoot, path.join(manifest.artifactDir, "request.md")))).content,
    };

    if (input.stage === "criteria") {
      common.designIntent = await artifact("design_intent");
      common.codeConvention = await readOptional("docs/code-convention.yaml");
      common.adr = await readOptional("docs/adr.yaml");
    } else if (input.stage === "review") {
      common.designIntent = await artifact("design_intent");
      common.criteria = await artifact("criteria");
      common.prBody = await artifact("pr_body");
    } else if (input.stage === "fix") {
      common.designIntent = await artifact("design_intent");
      common.criteria = await artifact("criteria");
      common.review = await artifact("review");
      common.decisions = await artifact("decisions");
      common.worktree = manifest.worktree;
    }
    return common;
  }

  async record(input: {
    repoPath: string;
    runId: string;
    kind: ReviewArtifactKind;
    content: string;
    p1Findings?: number;
    unresolvedP1?: number;
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.#repoRoot(input.repoPath);
    const manifest = await this.#readManifest(repoRoot, input.runId);
    const required: Partial<Record<ReviewArtifactKind, ReviewArtifactKind[]>> = {
      criteria: ["design_intent"],
      pr_body: ["design_intent", "criteria"],
      review: ["design_intent", "criteria", "pr_body"],
      decisions: ["review"],
    };
    for (const dependency of required[input.kind] ?? []) {
      if (!manifest.artifacts[dependency]) {
        throw new Error(`${input.kind} requires ${dependency} to be recorded first`);
      }
    }

    if (input.kind === "design_intent") {
      await this.#invalidate(
        manifest,
        ["criteria", "pr_body", "review", "decisions", "final_report"],
        true,
      );
      delete manifest.reviewGate;
    } else if (input.kind === "criteria") {
      await this.#invalidate(
        manifest,
        ["pr_body", "review", "decisions", "final_report"],
        true,
      );
      delete manifest.reviewGate;
    } else if (input.kind === "pr_body") {
      await this.#invalidate(manifest, ["review", "decisions", "final_report"], true);
      delete manifest.reviewGate;
    } else if (input.kind === "review") {
      if (!Number.isInteger(input.p1Findings) || input.p1Findings! < 0) {
        throw new Error("Recording review findings requires non-negative integer p1Findings");
      }
      await this.#invalidate(manifest, ["decisions", "final_report"], true);
      manifest.reviewGate = { p1Findings: input.p1Findings!, unresolvedP1: null };
    } else if (input.kind === "decisions") {
      if (!manifest.reviewGate) throw new Error("Review gate metadata is missing");
      if (!Number.isInteger(input.unresolvedP1) || input.unresolvedP1! < 0) {
        throw new Error("Recording review decisions requires non-negative integer unresolvedP1");
      }
      if (input.unresolvedP1! > manifest.reviewGate.p1Findings) {
        throw new Error("unresolvedP1 cannot exceed the number of P1 findings");
      }
      await this.#invalidate(manifest, ["final_report"], true);
      manifest.reviewGate.unresolvedP1 = input.unresolvedP1!;
    } else if (input.kind === "final_report") {
      if (!manifest.artifacts.decisions) throw new Error("final_report requires decisions to be recorded first");
      if (!manifest.qa?.passed) throw new Error("final_report requires a passing QA run");
      if (manifest.reviewGate?.unresolvedP1 !== 0) {
        throw new Error("final_report requires all P1 findings to be resolved");
      }
    }

    const filename = ARTIFACT_FILES[input.kind];
    await writeFile(path.join(manifest.artifactDir, filename), `${input.content.trimEnd()}\n`, "utf8");
    manifest.artifacts[input.kind] = filename;
    const stateByArtifact: Partial<Record<ReviewArtifactKind, ReviewState>> = {
      design_intent: "INTENT_READY",
      criteria: manifest.artifacts.pr_body ? "REVIEW_READY" : "CRITERIA_READY",
      pr_body: "REVIEW_READY",
      review: "REVIEWED",
      decisions: "FIXING",
      final_report: "PASSED",
    };
    manifest.state = stateByArtifact[input.kind] ?? manifest.state;
    await this.#writeManifest(manifest);
    return {
      runId: manifest.runId,
      kind: input.kind,
      filename,
      state: manifest.state,
      reviewGate: manifest.reviewGate,
    };
  }

  async worktree(input: {
    repoPath: string;
    runId: string;
    action: "create" | "status" | "remove";
    writable?: boolean;
    force?: boolean;
    deleteBranch?: boolean;
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.#repoRoot(input.repoPath);
    const manifest = await this.#readManifest(repoRoot, input.runId);
    if (input.action === "status") {
      if (!manifest.worktree) return { runId: manifest.runId, exists: false };
      const present = await exists(manifest.worktree.path);
      const gitStatus = present
        ? await this.#git(manifest.worktree.path, ["status", "--short", "--branch"])
        : "";
      return { runId: manifest.runId, exists: present, worktree: manifest.worktree, gitStatus };
    }

    if (input.action === "create") {
      if (manifest.worktree && (await exists(manifest.worktree.path))) {
        throw new Error(`Review worktree already exists: ${manifest.worktree.path}`);
      }
      const parent = path.join(path.dirname(repoRoot), ".project-moon-worktrees", path.basename(repoRoot));
      await mkdir(parent, { recursive: true });
      const worktreePath = path.join(parent, manifest.runId);
      const writable = input.writable ?? false;
      let branch: string | undefined;
      if (writable) {
        branch = `moon-review/${manifest.runId}`;
        await this.#git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, manifest.headSha]);
      } else {
        await this.#git(repoRoot, ["worktree", "add", "--detach", worktreePath, manifest.headSha]);
      }
      manifest.worktree = {
        path: worktreePath,
        mode: writable ? "writable" : "detached",
        branch,
        createdAt: new Date().toISOString(),
      };
      await this.#writeManifest(manifest);
      return { runId: manifest.runId, created: true, worktree: manifest.worktree };
    }

    if (!manifest.worktree) return { runId: manifest.runId, removed: false, reason: "no worktree" };
    const prior = manifest.worktree;
    await this.#git(repoRoot, ["worktree", "remove", ...(input.force ? ["--force"] : []), prior.path]);
    if (input.deleteBranch && prior.branch) {
      await this.#git(repoRoot, ["branch", input.force ? "-D" : "-d", prior.branch]);
    }
    delete manifest.worktree;
    await this.#writeManifest(manifest);
    return { runId: manifest.runId, removed: true, path: prior.path, branch: prior.branch };
  }

  async qa(input: {
    repoPath: string;
    runId: string;
    commands?: string[];
    useWorktree?: boolean;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.#repoRoot(input.repoPath);
    const manifest = await this.#readManifest(repoRoot, input.runId);
    if (!manifest.artifacts.review || !manifest.artifacts.decisions) {
      throw new Error("QA requires completed review findings and decisions");
    }
    const useWorktree = input.useWorktree ?? true;
    const targetPath = useWorktree && manifest.worktree ? manifest.worktree.path : repoRoot;
    if (!(await exists(targetPath))) throw new Error(`QA target does not exist: ${targetPath}`);

    let commands = input.commands?.filter((value) => value.trim().length > 0) ?? [];
    if (commands.length === 0) {
      const packagePath = path.join(targetPath, "package.json");
      if (!(await exists(packagePath))) {
        throw new Error("No QA commands supplied and package.json was not found");
      }
      const pkg = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, string> };
      for (const script of ["test", "typecheck", "build"]) {
        if (pkg.scripts?.[script]) commands.push(`npm run ${script}`);
      }
      if (commands.length === 0) throw new Error("No test/typecheck/build scripts found; supply commands explicitly");
    }

    const results: QaCommandResult[] = [];
    const timeoutMs = input.timeoutMs ?? 5 * 60_000;
    for (const command of commands) {
      const started = Date.now();
      try {
        const result = await this.#command("/bin/bash", ["-lc", command], {
          cwd: targetPath,
          timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
        });
        results.push({
          command,
          exitCode: 0,
          stdout: bounded(result.stdout, MAX_QA_OUTPUT_CHARS).content,
          stderr: bounded(result.stderr, MAX_QA_OUTPUT_CHARS).content,
          durationMs: Date.now() - started,
          timedOut: false,
        });
      } catch (error) {
        const value = error as NodeJS.ErrnoException & {
          code?: string | number;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
          signal?: string;
        };
        const numericCode = typeof value.code === "number" ? value.code : 1;
        results.push({
          command,
          exitCode: numericCode,
          stdout: bounded(String(value.stdout ?? ""), MAX_QA_OUTPUT_CHARS).content,
          stderr: bounded(String(value.stderr ?? value.message ?? ""), MAX_QA_OUTPUT_CHARS).content,
          durationMs: Date.now() - started,
          timedOut: Boolean(value.killed || value.signal === "SIGTERM"),
        });
        break;
      }
    }
    const passed = results.length === commands.length && results.every((result) => result.exitCode === 0);
    manifest.qa = {
      passed,
      targetPath,
      completedAt: new Date().toISOString(),
      results,
    };
    manifest.state = passed ? "QA" : "QA_FAILED";
    await writeFile(path.join(manifest.artifactDir, "qa.json"), `${JSON.stringify(manifest.qa, null, 2)}\n`, "utf8");
    await this.#writeManifest(manifest);
    return { runId: manifest.runId, passed, state: manifest.state, targetPath, results };
  }

  async status(input: { repoPath: string; runId: string }): Promise<Record<string, unknown>> {
    const repoRoot = await this.#repoRoot(input.repoPath);
    const manifest = await this.#readManifest(repoRoot, input.runId);
    const currentHead = await this.#git(repoRoot, ["rev-parse", manifest.headBranch]);
    const stale = currentHead !== manifest.headSha;
    let worktreeExists = false;
    let worktreeStatus = "";
    let worktreeHeadSha: string | undefined;
    if (manifest.worktree) {
      worktreeExists = await exists(manifest.worktree.path);
      if (worktreeExists) {
        worktreeStatus = await this.#git(manifest.worktree.path, ["status", "--porcelain=v1"]);
        worktreeHeadSha = await this.#git(manifest.worktree.path, ["rev-parse", "HEAD"]);
      }
    }
    const fixesPending =
      manifest.worktree?.mode === "writable" &&
      worktreeExists &&
      (worktreeStatus.length > 0 || worktreeHeadSha !== manifest.headSha);
    const readyToPush =
      !stale &&
      !fixesPending &&
      manifest.state === "PASSED" &&
      manifest.qa?.passed === true &&
      manifest.reviewGate?.unresolvedP1 === 0;
    return {
      ...manifest,
      stale,
      effectiveState: stale ? "STALE" : manifest.state,
      currentHeadSha: currentHead,
      worktreeExists,
      worktreeStatus,
      worktreeHeadSha,
      fixesPending,
      readyToPush,
    };
  }
}
