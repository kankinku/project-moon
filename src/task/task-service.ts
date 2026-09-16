import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadHarnessConfig } from "./task-config.js";
import { TaskRepository } from "./task-repository.js";
import { classifyRisk } from "./task-risk.js";
import { TaskStore } from "./task-store.js";
import type {
  TaskArtifactKind,
  MoonHarnessConfig,
  TaskManifest,
  TaskRiskLevel,
  TaskValidationCommandResult,
} from "./task-types.js";
import { bounded, safeSegment } from "./task-utils.js";
import { runValidationCommand } from "./task-validation.js";

const MAX_CONTEXT_CHARS = 180_000;

const ARTIFACT_FILES: Record<TaskArtifactKind, string> = {
  context_brief: "context-brief.md",
  plan: "plan.md",
};

const STAGE_PROMPTS = {
  brief:
    "Understand the repository before implementation. Summarize the user goal, current structure, relevant components, invariants, constraints, unknowns, risks, and proposed direction. Do not implement yet and do not invent requirements unsupported by evidence.",
  plan:
    "Create an implementation plan from the recorded context brief. Prefer the smallest architecture-preserving change, identify files and tests likely to change, define programmatic validation, and call out decisions requiring human approval only when they cross a meaningful architecture/security/irreversibility boundary.",
  execute:
    "Implement the recorded plan without silently redesigning it. If new evidence invalidates the plan, stop and revise the brief/plan first. Keep domain logic, infrastructure, and presentation responsibilities separated according to repository policy.",
  validate:
    "Use programmatic validation before semantic review. Run the required validation profile for the current risk level, inspect failures as harness or implementation evidence, and do not declare completion from reasoning alone.",
} as const;

export type TaskContextStage = keyof typeof STAGE_PROMPTS;

export class TaskService {
  constructor(
    private readonly repository = new TaskRepository(),
    private readonly store = new TaskStore(),
  ) {}

  async start(input: {
    repoPath: string;
    request: string;
    domainContext?: string;
    riskHint?: "auto" | TaskRiskLevel;
    requireClean?: boolean;
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.repository.root(input.repoPath);
    const request = input.request.trim();
    if (!request) throw new Error("request must not be empty");

    const status = await this.repository.git(repoRoot, ["status", "--porcelain=v1"]);
    const dirtyAtStart = status.length > 0;
    if ((input.requireClean ?? true) && dirtyAtStart) {
      throw new Error(
        "Task start requires a clean working tree by default. Commit/stash changes or set requireClean=false deliberately.",
      );
    }

    const branch = (await this.repository.git(repoRoot, ["branch", "--show-current"])) || "detached";
    const baseSha = await this.repository.git(repoRoot, ["rev-parse", "HEAD"]);
    const { config, configFile } = await loadHarnessConfig(repoRoot);
    const discovery = await this.repository.discover(repoRoot, configFile);
    const hint = input.riskHint && input.riskHint !== "auto" ? input.riskHint : undefined;
    const risk = classifyRisk(config, `${request}\n${input.domainContext ?? ""}`, [], hint);

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const runId = `${stamp}-${baseSha.slice(0, 8)}-${randomBytes(2).toString("hex")}`;
    const artifactDir = path.join(repoRoot, ".moon", "tasks", safeSegment(branch), runId);
    await mkdir(artifactDir, { recursive: true });
    await this.repository.ensureLocalIgnore(repoRoot);
    const policySnapshotFile = "harness-policy.json";
    const policySnapshotContent = `${JSON.stringify(config, null, 2)}\n`;
    await writeFile(path.join(artifactDir, policySnapshotFile), policySnapshotContent, "utf8");
    const policySnapshotHash = createHash("sha256").update(policySnapshotContent).digest("hex");

    const now = new Date().toISOString();
    const manifest: TaskManifest = {
      schemaVersion: 1,
      runId,
      repoRoot,
      branch,
      baseSha,
      createdAt: now,
      updatedAt: now,
      state: "CONTEXT_READY",
      request,
      domainContext: input.domainContext?.trim() || undefined,
      artifactDir,
      artifacts: {},
      discovery,
      risk,
      policySnapshot: {
        file: policySnapshotFile,
        sha256: policySnapshotHash,
        sourceFile: configFile,
      },
    };
    await this.store.write(manifest);

    return {
      runId,
      state: manifest.state,
      repoRoot,
      branch,
      baseSha,
      dirtyAtStart,
      risk,
      requiredValidationProfile: config.validation.riskProfiles[risk.level],
      discovery,
    };
  }

  async context(input: {
    repoPath: string;
    runId: string;
    stage: TaskContextStage;
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.repository.root(input.repoPath);
    const manifest = await this.store.read(repoRoot, input.runId);
    const config = await this.pinnedConfig(manifest);
    const changedPaths = await this.repository.changedPaths(repoRoot, manifest.baseSha);
    const currentRisk = classifyRisk(
      config,
      `${manifest.request}\n${manifest.domainContext ?? ""}`,
      changedPaths,
      manifest.risk.hint,
    );

    const context: Record<string, unknown> = {
      stage: input.stage,
      prompt: STAGE_PROMPTS[input.stage],
      runId: manifest.runId,
      state: manifest.state,
      request: manifest.request,
      domainContext: manifest.domainContext ?? "",
      branch: manifest.branch,
      baseSha: manifest.baseSha,
      discovery: manifest.discovery,
      risk: currentRisk,
      requiredValidationProfile: config.validation.riskProfiles[currentRisk.level],
      changedPaths,
    };

    if (input.stage === "brief") {
      context.policies = await this.repository.policyContext(repoRoot, manifest.discovery.policyFiles);
    }
    if (["plan", "execute", "validate"].includes(input.stage)) {
      const briefFile = manifest.artifacts.context_brief;
      if (briefFile) context.contextBrief = await readFile(path.join(manifest.artifactDir, briefFile), "utf8");
    }
    if (["execute", "validate"].includes(input.stage)) {
      const planFile = manifest.artifacts.plan;
      if (planFile) context.plan = await readFile(path.join(manifest.artifactDir, planFile), "utf8");
      const diff = await this.repository.git(repoRoot, ["diff", "--binary", manifest.baseSha]);
      context.diff = bounded(diff, MAX_CONTEXT_CHARS).content;
    }
    if (input.stage === "validate") context.validation = config.validation;
    return context;
  }

  async record(input: {
    repoPath: string;
    runId: string;
    kind: TaskArtifactKind;
    content: string;
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.repository.root(input.repoPath);
    const manifest = await this.store.read(repoRoot, input.runId);
    const content = input.content.trim();
    if (!content) throw new Error("content must not be empty");
    if (input.kind === "plan" && !manifest.artifacts.context_brief) {
      throw new Error("Recording a plan requires context_brief first");
    }

    if (input.kind === "context_brief") {
      const downstream = manifest.artifacts.plan;
      if (downstream) await rm(path.join(manifest.artifactDir, downstream), { force: true });
      delete manifest.artifacts.plan;
      this.invalidateValidation(manifest);
      manifest.state = "BRIEF_READY";
    } else {
      this.invalidateValidation(manifest);
      manifest.state = "PLAN_READY";
    }
    await rm(path.join(manifest.artifactDir, "validation.json"), { force: true });
    await rm(path.join(manifest.artifactDir, "completion.md"), { force: true });

    const filename = ARTIFACT_FILES[input.kind];
    await writeFile(path.join(manifest.artifactDir, filename), `${content}\n`, "utf8");
    manifest.artifacts[input.kind] = filename;
    await this.store.write(manifest);
    return { runId: manifest.runId, kind: input.kind, state: manifest.state, artifact: filename };
  }

  async validate(input: {
    repoPath: string;
    runId: string;
    profile?: string;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.repository.root(input.repoPath);
    const manifest = await this.store.read(repoRoot, input.runId);
    if (!manifest.artifacts.plan) throw new Error("Task validation requires a recorded plan");

    const config = await this.pinnedConfig(manifest);
    const changedPaths = await this.repository.changedPaths(repoRoot, manifest.baseSha);
    const risk = classifyRisk(
      config,
      `${manifest.request}\n${manifest.domainContext ?? ""}`,
      changedPaths,
      manifest.risk.hint,
    );
    manifest.risk = risk;

    const requiredProfile = config.validation.riskProfiles[risk.level];
    const profile = input.profile?.trim() || requiredProfile;
    const requiredIndex = config.validation.profileOrder.indexOf(requiredProfile);
    const selectedIndex = config.validation.profileOrder.indexOf(profile);
    if (selectedIndex < 0) throw new Error(`Unknown validation profile: ${profile}`);
    if (selectedIndex < requiredIndex) {
      throw new Error(
        `Validation profile ${profile} is weaker than required profile ${requiredProfile} for ${risk.level}-risk changes`,
      );
    }

    const commands = config.validation.profiles[profile] ?? [];
    if (commands.length === 0) {
      throw new Error(
        `Validation profile ${profile} has no commands. Define moon.config.json or package scripts before completing the task.`,
      );
    }

    manifest.state = "VALIDATING";
    delete manifest.completedAt;
    await this.store.write(manifest);

    const results: TaskValidationCommandResult[] = [];
    const timeoutMs = input.timeoutMs ?? 5 * 60 * 1000;
    for (const command of commands) {
      const result = await runValidationCommand(repoRoot, command, timeoutMs, {
        MOON_CONFIG_PATH: path.join(manifest.artifactDir, manifest.policySnapshot.file),
      });
      results.push(result);
      if (result.exitCode !== 0 || result.timedOut) break;
    }

    const passed = results.length === commands.length && results.every((result) => result.exitCode === 0 && !result.timedOut);
    const fingerprint = await this.repository.fingerprint(repoRoot);
    manifest.validation = {
      profile,
      requiredProfile,
      passed,
      fingerprint,
      completedAt: new Date().toISOString(),
      results,
    };
    manifest.state = passed ? "VERIFIED" : "VALIDATION_FAILED";
    await writeFile(path.join(manifest.artifactDir, "validation.json"), `${JSON.stringify(manifest.validation, null, 2)}\n`, "utf8");
    await this.store.write(manifest);

    return {
      runId: manifest.runId,
      state: manifest.state,
      passed,
      risk,
      profile,
      requiredProfile,
      changedPaths,
      fingerprint,
      results,
    };
  }

  async complete(input: {
    repoPath: string;
    runId: string;
    summary?: string;
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.repository.root(input.repoPath);
    const manifest = await this.store.read(repoRoot, input.runId);
    if (manifest.state !== "VERIFIED" || !manifest.validation?.passed) {
      throw new Error("Task completion requires a fresh passing validation run");
    }

    const currentFingerprint = await this.repository.fingerprint(repoRoot);
    if (currentFingerprint !== manifest.validation.fingerprint) {
      throw new Error("Working tree changed after validation; rerun task_validate before completion");
    }

    const now = new Date().toISOString();
    const summary = input.summary?.trim();
    if (summary) await writeFile(path.join(manifest.artifactDir, "completion.md"), `${summary}\n`, "utf8");
    manifest.state = "COMPLETE";
    manifest.completedAt = now;
    await this.store.write(manifest);
    return {
      runId: manifest.runId,
      state: manifest.state,
      completedAt: now,
      validationProfile: manifest.validation.profile,
      fingerprint: currentFingerprint,
    };
  }

  async status(input: {
    repoPath: string;
    runId: string;
  }): Promise<Record<string, unknown>> {
    const repoRoot = await this.repository.root(input.repoPath);
    const manifest = await this.store.read(repoRoot, input.runId);
    const config = await this.pinnedConfig(manifest);
    const changedPaths = await this.repository.changedPaths(repoRoot, manifest.baseSha);
    const currentRisk = classifyRisk(
      config,
      `${manifest.request}\n${manifest.domainContext ?? ""}`,
      changedPaths,
      manifest.risk.hint,
    );
    const currentFingerprint = await this.repository.fingerprint(repoRoot);
    const validationFresh = Boolean(manifest.validation?.passed && manifest.validation.fingerprint === currentFingerprint);
    const stale = Boolean(manifest.validation && ["VERIFIED", "COMPLETE"].includes(manifest.state) && !validationFresh);

    return {
      ...manifest,
      risk: currentRisk,
      changedPaths,
      currentFingerprint,
      validationFresh,
      stale,
      effectiveState: stale ? "STALE" : manifest.state,
      requiredValidationProfile: config.validation.riskProfiles[currentRisk.level],
      readyToComplete: manifest.state === "VERIFIED" && validationFresh,
      complete: manifest.state === "COMPLETE" && validationFresh,
    };
  }

  private async pinnedConfig(manifest: TaskManifest): Promise<MoonHarnessConfig> {
    const snapshotPath = path.join(manifest.artifactDir, manifest.policySnapshot.file);
    const content = await readFile(snapshotPath, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== manifest.policySnapshot.sha256) {
      throw new Error("Pinned harness policy snapshot was modified; start a new task run");
    }
    return JSON.parse(content) as MoonHarnessConfig;
  }

  private invalidateValidation(manifest: TaskManifest): void {
    delete manifest.validation;
    delete manifest.completedAt;
  }
}
