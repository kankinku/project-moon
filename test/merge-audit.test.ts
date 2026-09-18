import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  MergeAuditService,
  REQUIRED_REVIEW_CATEGORIES,
} from "../src/merge-audit/merge-audit-service.js";
import type {
  MergeAuditCoverage,
  MergeAuditFinding,
  MergeAuditValidationEvidence,
} from "../src/merge-audit/merge-audit-types.js";

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

function fullCoverage(overrides: Partial<Record<string, "PASS" | "CONCERN" | "NOT_APPLICABLE">> = {}): MergeAuditCoverage[] {
  return REQUIRED_REVIEW_CATEGORIES.map((category) => ({
    category,
    verdict: overrides[category] ?? "PASS",
    evidence: `Reviewed ${category} against the pinned diff and project policy.`,
  }));
}

function validation(headSha: string, profile = "release"): MergeAuditValidationEvidence[] {
  return [{
    source: "moon_task",
    profile,
    headSha,
    passed: true,
    reference: "task-run-verified",
    summary: "Required deterministic validation profile passed for the pinned commit.",
  }];
}

describe("independent full merge audit", () => {
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

  async function start(service: MergeAuditService, repo: string, request?: string) {
    return service.start({
      repoPath: repo,
      repository: "example/project",
      pullNumber: 17,
      baseBranch: "main",
      headBranch: "feature/audit",
      request,
      internalAuditSummary: "Developer-side review completed; independently verify it.",
    });
  }

  it("requires complete review coverage and validation before exact-SHA approval", async () => {
    const { repo, featureSha } = await fixture();
    const service = new MergeAuditService();
    const started = await start(service, repo, "Add the feature safely");

    expect(started).toMatchObject({
      headSha: featureSha,
      state: "INPUT_PINNED",
      target: { repository: "example/project", pullNumber: 17 },
    });

    const context = await service.context({ repoPath: repo, runId: String(started.runId) });
    expect(context).toMatchObject({
      pinnedHeadSha: featureSha,
      stale: false,
      requiredReviewCategories: REQUIRED_REVIEW_CATEGORIES,
    });
    expect(String(context.diff)).toContain("feature.txt");

    const decision = await service.decide({
      repoPath: repo,
      runId: String(started.runId),
      decision: "MERGE_APPROVED",
      rationale: "All mandatory review categories and deterministic validation evidence passed.",
      findings: [],
      coverage: fullCoverage(),
      validationEvidence: validation(featureSha),
    });
    expect(decision).toMatchObject({
      decision: "MERGE_APPROVED",
      approvalSha: featureSha,
      unresolvedP1: 0,
      validationSatisfied: true,
      readyToMerge: true,
    });

    const status = await service.status({ repoPath: repo, runId: String(started.runId) });
    expect(status).toMatchObject({
      stale: false,
      baseStale: false,
      headStale: false,
      coverageComplete: true,
      qualityGateSatisfied: true,
      readyToMerge: true,
    });
  });

  it("invalidates approval when either reviewed head or pinned base moves", async () => {
    const { repo, featureSha } = await fixture();
    const service = new MergeAuditService();
    const started = await start(service, repo);
    await service.decide({
      repoPath: repo,
      runId: String(started.runId),
      decision: "MERGE_APPROVED",
      rationale: "Pinned revision passed the full independent review.",
      findings: [],
      coverage: fullCoverage(),
      validationEvidence: validation(featureSha),
    });

    await git(repo, "checkout", "main");
    await commitFile(repo, "base-after-audit.txt", "new base\n", "advance base");
    await git(repo, "checkout", "feature/audit");

    const status = await service.status({ repoPath: repo, runId: String(started.runId) });
    expect(status).toMatchObject({
      stale: true,
      baseStale: true,
      headStale: false,
      effectiveState: "STALE",
      readyToMerge: false,
    });
  });

  it("rejects approval when a blocking P1 remains", async () => {
    const { repo, featureSha } = await fixture();
    const service = new MergeAuditService();
    const started = await start(service, repo);
    const findings: MergeAuditFinding[] = [{
      id: "P1-001",
      severity: "P1",
      category: "correctness",
      title: "Incorrect state transition",
      evidence: "The pinned diff can enter an invalid state on the error path.",
      file: "feature.txt",
      line: 1,
      recommendation: "Correct the transition and add a regression test.",
      resolved: false,
    }];

    await expect(
      service.decide({
        repoPath: repo,
        runId: String(started.runId),
        decision: "MERGE_APPROVED",
        rationale: "Attempted approval despite a blocker.",
        findings,
        coverage: fullCoverage(),
        validationEvidence: validation(featureSha),
      }),
    ).rejects.toThrow(/unresolved P1/);
  });

  it("rejects approval when full review coverage has a concern or is incomplete", async () => {
    const { repo, featureSha } = await fixture();
    const service = new MergeAuditService();
    const started = await start(service, repo);

    await expect(
      service.decide({
        repoPath: repo,
        runId: String(started.runId),
        decision: "MERGE_APPROVED",
        rationale: "Missing maintainability review.",
        findings: [],
        coverage: fullCoverage().filter((item) => item.category !== "maintainability"),
        validationEvidence: validation(featureSha),
      }),
    ).rejects.toThrow(/missing required categories/);

    await expect(
      service.decide({
        repoPath: repo,
        runId: String(started.runId),
        decision: "MERGE_APPROVED",
        rationale: "Security concern remains.",
        findings: [],
        coverage: fullCoverage({ security: "CONCERN" }),
        validationEvidence: validation(featureSha),
      }),
    ).rejects.toThrow(/security/);
  });

  it("requires risk-profile validation evidence bound to the audited SHA", async () => {
    const { repo, featureSha } = await fixture();
    const service = new MergeAuditService();
    const started = await start(service, repo, "security-sensitive authentication feature");

    expect(started).toMatchObject({
      risk: { level: "high", requiredValidationProfile: "release" },
    });

    await expect(
      service.decide({
        repoPath: repo,
        runId: String(started.runId),
        decision: "MERGE_APPROVED",
        rationale: "Fast validation is insufficient for a high-risk change.",
        findings: [],
        coverage: fullCoverage(),
        validationEvidence: validation(featureSha, "fast"),
      }),
    ).rejects.toThrow(/profile release/);

    await expect(
      service.decide({
        repoPath: repo,
        runId: String(started.runId),
        decision: "MERGE_APPROVED",
        rationale: "Validation belongs to another commit.",
        findings: [],
        coverage: fullCoverage(),
        validationEvidence: validation("f".repeat(40), "release"),
      }),
    ).rejects.toThrow(/audited head SHA/);
  });

  it("rejects legacy audit manifests instead of treating old approvals as full-review approvals", async () => {
    const { repo } = await fixture();
    const runId = "legacy-run";
    const artifactDir = path.join(repo, ".moon", "merge-audits", "feature-audit", runId);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      path.join(artifactDir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        repoRoot: repo,
        baseBranch: "main",
        headBranch: "feature/audit",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        mergeBase: "a".repeat(40),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        state: "MERGE_APPROVED",
        decision: "MERGE_APPROVED",
        unresolvedP1: 0,
        changedFiles: [],
        diffStat: "",
        artifactDir,
      }),
      "utf8",
    );

    const service = new MergeAuditService();
    await expect(service.status({ repoPath: repo, runId })).rejects.toThrow(/Legacy merge audit run/);
  });

  it("uses the pinned base policy even when the feature branch weakens moon.config.json", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "project-moon-merge-policy-"));
    roots.push(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "Moon Test");
    await git(repo, "config", "user.email", "moon-test@example.invalid");

    const baseConfig = {
      schemaVersion: 1,
      validation: {
        profileOrder: ["fast", "normal", "release"],
        profiles: { fast: [], normal: [], release: [] },
        riskProfiles: { low: "fast", medium: "normal", high: "release" },
      },
      risk: {
        highPathPatterns: ["^secure\\.txt$"],
        mediumPathPatterns: [],
        highKeywords: [],
        mediumKeywords: [],
      },
    };
    await writeFile(path.join(repo, "moon.config.json"), `${JSON.stringify(baseConfig, null, 2)}\n`, "utf8");
    await writeFile(path.join(repo, "base.txt"), "base\n", "utf8");
    await git(repo, "add", "moon.config.json", "base.txt");
    await git(repo, "commit", "-m", "base policy");

    await git(repo, "checkout", "-b", "feature/audit");
    const weakenedConfig = {
      ...baseConfig,
      validation: {
        ...baseConfig.validation,
        riskProfiles: { low: "fast", medium: "fast", high: "fast" },
      },
      risk: {
        ...baseConfig.risk,
        highPathPatterns: [],
      },
    };
    await writeFile(path.join(repo, "moon.config.json"), `${JSON.stringify(weakenedConfig, null, 2)}\n`, "utf8");
    await writeFile(path.join(repo, "secure.txt"), "sensitive change\n", "utf8");
    await git(repo, "add", "moon.config.json", "secure.txt");
    await git(repo, "commit", "-m", "weaken policy and change secure file");

    const service = new MergeAuditService();
    const started = await start(service, repo);

    expect(started).toMatchObject({
      risk: {
        level: "high",
        requiredValidationProfile: "release",
        reasons: expect.arrayContaining([expect.stringContaining("secure.txt")]),
      },
    });
    const context = await service.context({ repoPath: repo, runId: String(started.runId) });
    expect(context).toMatchObject({ policySourceSha: expect.any(String) });
    expect(JSON.parse(String((context.policies as { moonConfig: { content: string } }).moonConfig.content)))
      .toMatchObject({ risk: { highPathPatterns: ["^secure\\.txt$"] } });
  });

});
