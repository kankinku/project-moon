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
import { TaskRepository } from "../src/task/task-repository.js";

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

function fullCoverage(
  overrides: Partial<Record<string, "PASS" | "CONCERN" | "NOT_APPLICABLE">> = {},
): MergeAuditCoverage[] {
  return REQUIRED_REVIEW_CATEGORIES.map((category) => ({
    category,
    verdict: overrides[category] ?? "PASS",
    evidence: `Reviewed ${category} against the pinned diff and project policy.`,
  }));
}

function supplementalValidation(
  headSha: string,
  profile = "release",
): MergeAuditValidationEvidence[] {
  return [{
    source: "external_ci",
    profile,
    headSha,
    passed: true,
    reference: "validate",
    summary: "GitHub CI reported success for the pinned commit.",
  }];
}

describe("independent full merge audit", () => {
  const roots: string[] = [];
  let taskSequence = 0;

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{ repo: string; baseSha: string; featureSha: string }> {
    const repo = await mkdtemp(path.join(os.tmpdir(), "project-moon-merge-audit-"));
    roots.push(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "Moon Test");
    await git(repo, "config", "user.email", "moon-test@example.invalid");
    await writeFile(path.join(repo, ".git", "info", "exclude"), ".moon/\n", { flag: "a" });
    await mkdir(path.join(repo, ".github", "workflows"), { recursive: true });
    await writeFile(
      path.join(repo, "moon.config.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        validation: {
          profileOrder: ["fast", "normal", "release"],
          profiles: {
            fast: ["npm run typecheck"],
            normal: ["npm run typecheck", "npm test"],
            release: ["npm run typecheck", "npm test", "npm run build"],
          },
          riskProfiles: { low: "fast", medium: "normal", high: "release" },
        },
        risk: {
          highPathPatterns: [],
          mediumPathPatterns: [],
          highKeywords: ["security-sensitive", "authentication"],
          mediumKeywords: [],
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(repo, "package.json"),
      `${JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          test: "vitest run",
          build: "tsc",
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(repo, ".github", "workflows", "ci.yml"),
      `name: CI

on:
  pull_request:

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Typecheck
        run: npm run typecheck
      - name: Tests
        run: npm test
      - name: Build
        run: npm run build
`,
      "utf8",
    );
    await writeFile(path.join(repo, "base.txt"), "base\n", "utf8");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "base");
    const baseSha = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "-b", "feature/audit");
    const featureSha = await commitFile(repo, "feature.txt", "feature\n", "feature");
    return { repo, baseSha, featureSha };
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

  function githubServiceAndEvidence(
    headSha: string,
    baseSha: string,
    profile = "release",
    options: { failedStep?: string } = {},
  ): { service: MergeAuditService; evidence: MergeAuditValidationEvidence[] } {
    const githubCommand = async (args: string[]) => {
      const route = args[1] ?? "";
      if (route.endsWith("/actions/runs/123")) {
        return JSON.stringify({
          id: 123,
          head_sha: headSha,
          head_branch: "feature/audit",
          event: "pull_request",
          status: "completed",
          conclusion: "success",
          name: "CI",
          path: ".github/workflows/ci.yml",
          pull_requests: [{
            number: 17,
            head: { sha: headSha },
            base: { sha: baseSha },
          }],
        });
      }
      if (route.includes("/actions/runs/123/jobs")) {
        const step = (name: string) => ({
          name,
          status: "completed",
          conclusion: options.failedStep === name ? "failure" : "success",
        });
        return JSON.stringify({
          jobs: [{
            id: 999,
            name: "validate",
            status: "completed",
            conclusion: "success",
            head_sha: headSha,
            steps: [step("Typecheck"), step("Tests"), step("Build")],
          }],
        });
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };
    return {
      service: new MergeAuditService({ githubCommand }),
      evidence: [{
        source: "github_ci",
        profile,
        headSha,
        passed: true,
        reference: "https://github.com/example/project/actions/runs/123/job/999",
        summary: "Provider-verified GitHub Actions validation passed.",
      }],
    };
  }

  async function moonTaskValidation(
    repo: string,
    headSha: string,
    profile = "release",
    options: { passed?: boolean; state?: string; fingerprint?: string; reference?: string } = {},
  ): Promise<MergeAuditValidationEvidence[]> {
    const reference = options.reference ?? `task-run-${++taskSequence}`;
    const taskDir = path.join(repo, ".moon", "tasks", "feature-audit", reference);
    await mkdir(taskDir, { recursive: true });
    const fingerprint =
      options.fingerprint ?? await new TaskRepository().fingerprint(repo);
    const passed = options.passed ?? true;
    await writeFile(
      path.join(taskDir, "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        runId: reference,
        repoRoot: repo,
        branch: "feature/audit",
        baseSha: headSha,
        state: options.state ?? "COMPLETE",
        validation: {
          profile,
          requiredProfile: profile,
          passed,
          fingerprint,
          completedAt: new Date().toISOString(),
          results: [],
          insights: { repeatedFailures: [], performanceRegressions: [] },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    return [{
      source: "moon_task",
      profile,
      headSha,
      passed,
      reference,
      summary: "Moon task validation passed for the pinned commit.",
    }];
  }

  it("treats Moon task evidence as supplemental even when internally consistent", async () => {
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

    const inspection = await service.context({
      repoPath: repo,
      runId: String(started.runId),
      includePaths: ["base.txt"],
      searchTerms: ["feature"],
    });
    expect(inspection).toMatchObject({
      inspectionSourceSha: featureSha,
      inspectedFiles: [
        {
          path: "base.txt",
          exists: true,
          content: "base",
          truncated: false,
        },
      ],
    });
    expect(String(
      (inspection.searchResults as Array<{ matches: string }>)[0]?.matches ?? "",
    )).toContain("feature.txt:1:feature");

    await expect(
      service.context({
        repoPath: repo,
        runId: String(started.runId),
        includePaths: ["../outside-secret"],
      }),
    ).rejects.toThrow(/repository-relative Git paths/);

    const validationEvidence = await moonTaskValidation(repo, featureSha);
    await expect(
      service.decide({
        repoPath: repo,
        runId: String(started.runId),
        decision: "MERGE_APPROVED",
        rationale: "Developer-workspace task evidence must not satisfy the independent provider gate.",
        findings: [],
        coverage: fullCoverage(),
        validationEvidence,
      }),
    ).rejects.toThrow(/independently verified GitHub Actions evidence/);

    const supplemental = await service.decide({
      repoPath: repo,
      runId: String(started.runId),
      decision: "CHANGES_REQUIRED",
      rationale: "Moon task evidence was checked but remains supplemental.",
      findings: [],
      coverage: fullCoverage(),
      validationEvidence,
    });
    expect(supplemental).toMatchObject({
      decision: "CHANGES_REQUIRED",
      validationSatisfied: false,
      readyToMerge: false,
      verifiedValidationEvidence: [],
    });

    const status = await service.status({ repoPath: repo, runId: String(started.runId) });
    expect(status).toMatchObject({
      validationSatisfied: false,
      readyToMerge: false,
      validationEvidence: [
        expect.objectContaining({
          source: "moon_task",
          verified: false,
          verification: expect.stringContaining("supplemental only"),
        }),
      ],
    });
  });

  it("does not count unresolved external CI evidence toward the required validation profile", async () => {
    const { repo, featureSha } = await fixture();
    const service = new MergeAuditService();
    const started = await start(service, repo);

    await expect(
      service.decide({
        repoPath: repo,
        runId: String(started.runId),
        decision: "MERGE_APPROVED",
        rationale: "CI evidence alone should not satisfy the verified evidence gate.",
        findings: [],
        coverage: fullCoverage(),
        validationEvidence: supplementalValidation(featureSha),
      }),
    ).rejects.toThrow(/independently verified GitHub Actions evidence/);
  });

  it("rejects unknown or stale Moon task validation references", async () => {
    const { repo, featureSha } = await fixture();
    const service = new MergeAuditService();
    const started = await start(service, repo);

    await expect(
      service.decide({
        repoPath: repo,
        runId: String(started.runId),
        decision: "MERGE_APPROVED",
        rationale: "Unknown task evidence must fail.",
        findings: [],
        coverage: fullCoverage(),
        validationEvidence: [{
          source: "moon_task",
          profile: "release",
          headSha: featureSha,
          passed: true,
          reference: "does-not-exist",
          summary: "forged",
        }],
      }),
    ).rejects.toThrow(/Unknown Moon task validation reference/);

    const staleEvidence = await moonTaskValidation(repo, featureSha);
    await writeFile(path.join(repo, "feature.txt"), "dirty after validation\n", "utf8");
    await expect(
      service.decide({
        repoPath: repo,
        runId: String(started.runId),
        decision: "MERGE_APPROVED",
        rationale: "Stale task evidence must fail.",
        findings: [],
        coverage: fullCoverage(),
        validationEvidence: staleEvidence,
      }),
    ).rejects.toThrow(/stale: validated fingerprint/);
  });

  it("invalidates an audit when either reviewed head or pinned base moves", async () => {
    const { repo } = await fixture();
    const service = new MergeAuditService();
    const started = await start(service, repo);

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
        validationEvidence: await moonTaskValidation(repo, featureSha),
      }),
    ).rejects.toThrow(/unresolved P1/);
  });

  it("rejects approval when full review coverage has a concern or is incomplete", async () => {
    const { repo, featureSha } = await fixture();
    const service = new MergeAuditService();
    const started = await start(service, repo);
    const validationEvidence = await moonTaskValidation(repo, featureSha);

    await expect(
      service.decide({
        repoPath: repo,
        runId: String(started.runId),
        decision: "MERGE_APPROVED",
        rationale: "Missing maintainability review.",
        findings: [],
        coverage: fullCoverage().filter((item) => item.category !== "maintainability"),
        validationEvidence,
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
        validationEvidence,
      }),
    ).rejects.toThrow(/security/);
  });

  it("requires a provider-verified validation profile strong enough for the audited risk", async () => {
    const { repo, baseSha, featureSha } = await fixture();
    const { service, evidence: fastEvidence } = githubServiceAndEvidence(featureSha, baseSha, "fast");
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
        validationEvidence: fastEvidence,
      }),
    ).rejects.toThrow(/profile release/);

    const wrongShaEvidence = fastEvidence.map((item) => ({ ...item, profile: "release" }));
    wrongShaEvidence[0]!.headSha = "f".repeat(40);
    await expect(
      service.decide({
        repoPath: repo,
        runId: String(started.runId),
        decision: "MERGE_APPROVED",
        rationale: "Validation belongs to another commit.",
        findings: [],
        coverage: fullCoverage(),
        validationEvidence: wrongShaEvidence,
      }),
    ).rejects.toThrow(/does not match audited SHA/);
  });

  it("rejects schema-v1 through schema-v3 audit manifests under the provider-verified gate", async () => {
    const { repo } = await fixture();
    const service = new MergeAuditService();

    for (const schemaVersion of [1, 2, 3]) {
      const runId = `legacy-run-${schemaVersion}`;
      const artifactDir = path.join(repo, ".moon", "merge-audits", "feature-audit", runId);
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        path.join(artifactDir, "manifest.json"),
        JSON.stringify({
          schemaVersion,
          runId,
          repoRoot: repo,
          target: { repository: "example/project", pullNumber: 17 },
          risk: {
            level: "low",
            reasons: [],
            requiredValidationProfile: "fast",
            validationProfileOrder: ["fast", "normal", "release"],
          },
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

      await expect(service.status({ repoPath: repo, runId })).rejects.toThrow(/Legacy merge audit run/);
    }
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

  it("accepts provider-verified GitHub Actions evidence from an unchanged pinned workflow", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "project-moon-github-ci-audit-"));
    roots.push(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "Moon Test");
    await git(repo, "config", "user.email", "moon-test@example.invalid");
    await writeFile(path.join(repo, ".git", "info", "exclude"), ".moon/\n", { flag: "a" });
    await mkdir(path.join(repo, ".github", "workflows"), { recursive: true });

    const config = {
      schemaVersion: 1,
      validation: {
        profileOrder: ["fast", "normal", "release"],
        profiles: {
          fast: ["npm run typecheck"],
          normal: ["npm run typecheck", "npm test"],
          release: ["npm run typecheck", "npm test", "npm run build"],
        },
        riskProfiles: { low: "release", medium: "release", high: "release" },
      },
      risk: {
        highPathPatterns: [],
        mediumPathPatterns: [],
        highKeywords: [],
        mediumKeywords: [],
      },
    };
    const workflow = `name: CI

on:
  pull_request:

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Typecheck
        run: npm run typecheck
      - name: Tests
        run: npm test
      - name: Build
        run: npm run build
`;
    await writeFile(path.join(repo, "moon.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await writeFile(path.join(repo, "package.json"), `${JSON.stringify({
      scripts: { typecheck: "tsc --noEmit", test: "vitest run", build: "tsc" },
    }, null, 2)}\n`, "utf8");
    await writeFile(path.join(repo, ".github", "workflows", "ci.yml"), workflow, "utf8");
    await writeFile(path.join(repo, "base.txt"), "base\n", "utf8");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "base policy and CI");
    const baseSha = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "-b", "feature/audit");
    const featureSha = await commitFile(repo, "feature.txt", "feature\n", "feature");

    const githubCommand = async (args: string[]) => {
      const route = args[1] ?? "";
      if (route.endsWith("/actions/runs/123")) {
        return JSON.stringify({
          id: 123,
          head_sha: featureSha,
          head_branch: "feature/audit",
          event: "pull_request",
          status: "completed",
          conclusion: "success",
          name: "CI",
          path: ".github/workflows/ci.yml",
          pull_requests: [{
            number: 17,
            head: { sha: featureSha },
            base: { sha: baseSha },
          }],
        });
      }
      if (route.includes("/actions/runs/123/jobs")) {
        return JSON.stringify({
          jobs: [{
            id: 999,
            name: "validate",
            status: "completed",
            conclusion: "success",
            head_sha: featureSha,
            steps: [
              { name: "Typecheck", status: "completed", conclusion: "success" },
              { name: "Tests", status: "completed", conclusion: "success" },
              { name: "Build", status: "completed", conclusion: "success" },
            ],
          }],
        });
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const service = new MergeAuditService({ githubCommand });
    const started = await start(service, repo);
    expect(started).toMatchObject({
      risk: { requiredValidationProfile: "release" },
    });

    const decision = await service.decide({
      repoPath: repo,
      runId: String(started.runId),
      decision: "MERGE_APPROVED",
      rationale: "Trusted unchanged GitHub Actions workflow passed the release profile.",
      findings: [],
      coverage: fullCoverage(),
      validationEvidence: [{
        source: "github_ci",
        profile: "release",
        headSha: featureSha,
        passed: true,
        reference: "https://github.com/example/project/actions/runs/123/job/999",
        summary: "Provider-verified release workflow passed.",
      }],
    });

    expect(decision).toMatchObject({
      decision: "MERGE_APPROVED",
      validationSatisfied: true,
      readyToMerge: true,
      verifiedValidationEvidence: [
        expect.objectContaining({
          source: "github_ci",
          verified: true,
          verification: expect.stringContaining("Verified GitHub Actions run 123"),
        }),
      ],
    });
  });
});
