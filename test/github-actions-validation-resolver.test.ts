import { describe, expect, it } from "vitest";

import {
  GitHubActionsValidationResolver,
  parseGitHubActionsRunId,
} from "../src/github/github-actions-validation-resolver.js";

const workflow = `name: Project Moon CI

on:
  pull_request:

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Typecheck
        run: npm run typecheck
      - name: Tests
        run: npm test
      - name: Build
        run: |
          npm run build
`;

const packageJson = JSON.stringify({
  scripts: {
    typecheck: "tsc --noEmit",
    test: "vitest run",
    build: "tsc",
  },
});

function fixture(options: {
  headSha?: string;
  headBranch?: string;
  event?: string;
  status?: string;
  conclusion?: string;
  workflowPath?: string;
  pullNumber?: number;
  baseSha?: string;
  jobConclusion?: string;
  failedStep?: string;
} = {}) {
  const calls: string[][] = [];
  const headSha = options.headSha ?? "a".repeat(40);
  const baseSha = options.baseSha ?? "b".repeat(40);
  const command = async (args: string[]) => {
    calls.push(args);
    const route = args[1] ?? "";
    if (route.endsWith("/actions/runs/123")) {
      return JSON.stringify({
        id: 123,
        head_sha: headSha,
        head_branch: options.headBranch ?? "feature/audit",
        event: options.event ?? "pull_request",
        status: options.status ?? "completed",
        conclusion: options.conclusion ?? "success",
        name: "Project Moon CI",
        path: options.workflowPath ?? ".github/workflows/ci.yml",
        pull_requests: [{
          number: options.pullNumber ?? 17,
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
          conclusion: options.jobConclusion ?? "success",
          head_sha: headSha,
          steps: [
            step("Checkout"),
            step("Typecheck"),
            step("Tests"),
            step("Build"),
          ],
        }],
      });
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };

  return {
    calls,
    headSha,
    resolver: new GitHubActionsValidationResolver({ command }),
  };
}

describe("GitHubActionsValidationResolver", () => {
  it("parses run IDs from numeric references and GitHub Actions URLs", () => {
    expect(parseGitHubActionsRunId("123")).toBe(123);
    expect(parseGitHubActionsRunId("https://github.com/o/r/actions/runs/123")).toBe(123);
    expect(parseGitHubActionsRunId("https://github.com/o/r/actions/runs/123/job/999")).toBe(123);
    expect(() => parseGitHubActionsRunId("https://example.com/actions/runs/123")).toThrow(/github.com/);
    expect(() => parseGitHubActionsRunId("not-a-run")).toThrow(/run ID/);
  });

  it("verifies a successful unchanged workflow against required profile commands and steps", async () => {
    const { resolver, headSha } = fixture();
    const result = await resolver.resolve({
      repository: "example/project",
      reference: "https://github.com/example/project/actions/runs/123/job/999",
      expectedPullNumber: 17,
      expectedBaseSha: "b".repeat(40),
        expectedHeadSha: headSha,
      expectedHeadBranch: "feature/audit",
      expectedPassed: true,
      profile: "release",
      profileCommands: ["npm run typecheck", "npm test", "npm run build"],
      loadWorkflow: async () => ({ baseContent: workflow, headContent: workflow }),
      loadPackageJson: async () => ({ baseContent: packageJson, headContent: packageJson }),
    });

    expect(result).toMatchObject({
      runId: 123,
      workflowPath: ".github/workflows/ci.yml",
      jobNames: ["validate"],
      requiredStepNames: ["Typecheck", "Tests", "Build"],
      passed: true,
      verification: expect.stringContaining("Verified GitHub Actions run 123"),
    });
  });

  it("rejects wrong head identity or non-pull-request events", async () => {
    const wrongHead = fixture({ headSha: "b".repeat(40) });
    await expect(
      wrongHead.resolver.resolve({
        repository: "example/project",
        reference: "123",
        expectedPullNumber: 17,
        expectedBaseSha: "b".repeat(40),
        expectedHeadSha: "a".repeat(40),
        expectedHeadBranch: "feature/audit",
        expectedPassed: true,
        profile: "release",
        profileCommands: ["npm run build"],
        loadWorkflow: async () => ({ baseContent: workflow, headContent: workflow }),
        loadPackageJson: async () => ({ baseContent: packageJson, headContent: packageJson }),
      }),
    ).rejects.toThrow(/does not match audited SHA/);

    const wrongEvent = fixture({ event: "workflow_dispatch" });
    await expect(
      wrongEvent.resolver.resolve({
        repository: "example/project",
        reference: "123",
        expectedPullNumber: 17,
        expectedBaseSha: "b".repeat(40),
        expectedHeadSha: wrongEvent.headSha,
        expectedHeadBranch: "feature/audit",
        expectedPassed: true,
        profile: "release",
        profileCommands: ["npm run build"],
        loadWorkflow: async () => ({ baseContent: workflow, headContent: workflow }),
        loadPackageJson: async () => ({ baseContent: packageJson, headContent: packageJson }),
      }),
    ).rejects.toThrow(/must be pull_request/);
  });

  it("rejects a run associated with a different pull request", async () => {
    const wrongPr = fixture({ pullNumber: 99 });
    await expect(
      wrongPr.resolver.resolve({
        repository: "example/project",
        reference: "123",
        expectedPullNumber: 17,
        expectedBaseSha: "b".repeat(40),
        expectedHeadSha: wrongPr.headSha,
        expectedHeadBranch: "feature/audit",
        expectedPassed: true,
        profile: "release",
        profileCommands: ["npm run build"],
        loadWorkflow: async () => ({ baseContent: workflow, headContent: workflow }),
        loadPackageJson: async () => ({ baseContent: packageJson, headContent: packageJson }),
      }),
    ).rejects.toThrow(/not associated with audited pull request #17/);
  });

  it("rejects workflows changed by the audited branch", async () => {
    const { resolver, headSha } = fixture();
    await expect(
      resolver.resolve({
        repository: "example/project",
        reference: "123",
        expectedPullNumber: 17,
        expectedBaseSha: "b".repeat(40),
        expectedHeadSha: headSha,
        expectedHeadBranch: "feature/audit",
        expectedPassed: true,
        profile: "release",
        profileCommands: ["npm run build"],
        loadWorkflow: async () => ({
          baseContent: workflow,
          headContent: workflow.replace("npm run build", "true"),
        }),
        loadPackageJson: async () => ({ baseContent: packageJson, headContent: packageJson }),
      }),
    ).rejects.toThrow(/changed between pinned base and audited head/);
  });

  it("rejects changed npm validation script definitions even when workflow text is unchanged", async () => {
    const { resolver, headSha } = fixture();
    const weakenedPackageJson = JSON.stringify({
      scripts: {
        typecheck: "true",
        test: "vitest run",
        build: "tsc",
      },
    });
    await expect(
      resolver.resolve({
        repository: "example/project",
        reference: "123",
        expectedPullNumber: 17,
        expectedBaseSha: "b".repeat(40),
        expectedHeadSha: headSha,
        expectedHeadBranch: "feature/audit",
        expectedPassed: true,
        profile: "release",
        profileCommands: ["npm run typecheck", "npm test", "npm run build"],
        loadWorkflow: async () => ({ baseContent: workflow, headContent: workflow }),
        loadPackageJson: async () => ({
          baseContent: packageJson,
          headContent: weakenedPackageJson,
        }),
      }),
    ).rejects.toThrow(/npm validation script typecheck changed/);
  });

  it("does not treat validation command substrings as executed commands", async () => {
    const { resolver, headSha } = fixture();
    const misleadingWorkflow = workflow.replace("run: npm test", "run: echo npm test");
    await expect(
      resolver.resolve({
        repository: "example/project",
        reference: "123",
        expectedPullNumber: 17,
        expectedBaseSha: "b".repeat(40),
        expectedHeadSha: headSha,
        expectedHeadBranch: "feature/audit",
        expectedPassed: true,
        profile: "normal",
        profileCommands: ["npm test"],
        loadWorkflow: async () => ({
          baseContent: misleadingWorkflow,
          headContent: misleadingWorkflow,
        }),
        loadPackageJson: async () => ({ baseContent: packageJson, headContent: packageJson }),
      }),
    ).rejects.toThrow(/exactly one job mapping every validation command/);
  });

  it("fails closed when profile commands cannot map to one explicitly named workflow job", async () => {
    const { resolver, headSha } = fixture();
    await expect(
      resolver.resolve({
        repository: "example/project",
        reference: "123",
        expectedPullNumber: 17,
        expectedBaseSha: "b".repeat(40),
        expectedHeadSha: headSha,
        expectedHeadBranch: "feature/audit",
        expectedPassed: true,
        profile: "release",
        profileCommands: ["node scripts/missing-check.mjs"],
        loadWorkflow: async () => ({ baseContent: workflow, headContent: workflow }),
        loadPackageJson: async () => ({ baseContent: packageJson, headContent: packageJson }),
      }),
    ).rejects.toThrow(/exactly one job mapping every validation command/);
  });

  it("requires the trusted job and every required named step to succeed", async () => {
    const failed = fixture({ failedStep: "Tests" });
    await expect(
      failed.resolver.resolve({
        repository: "example/project",
        reference: "123",
        expectedPullNumber: 17,
        expectedBaseSha: "b".repeat(40),
        expectedHeadSha: failed.headSha,
        expectedHeadBranch: "feature/audit",
        expectedPassed: true,
        profile: "release",
        profileCommands: ["npm run typecheck", "npm test", "npm run build"],
        loadWorkflow: async () => ({ baseContent: workflow, headContent: workflow }),
        loadPackageJson: async () => ({ baseContent: packageJson, headContent: packageJson }),
      }),
    ).rejects.toThrow(/required validation step Tests did not succeed/);
  });
});
