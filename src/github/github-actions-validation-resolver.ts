import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitHubActionsGhCommand = (args: string[]) => Promise<string>;

interface ActionsRun {
  id?: number;
  head_sha?: string;
  head_branch?: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
  name?: string;
  path?: string;
  pull_requests?: Array<{ number?: number; head?: { sha?: string }; base?: { sha?: string } }>;
}

interface ActionsJobStep {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

interface ActionsJob {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string;
  steps?: ActionsJobStep[];
}

interface ActionsJobsResponse {
  jobs?: ActionsJob[];
}

interface ParsedWorkflowStep {
  name?: string;
  run?: string;
}

interface ParsedWorkflowJob {
  id: string;
  name: string;
  steps: ParsedWorkflowStep[];
}

interface TrustedWorkflowJob {
  jobName: string;
  requiredStepNames: string[];
}

export interface ResolveGitHubActionsEvidenceInput {
  repository: string;
  reference: string;
  expectedPullNumber: number;
  expectedBaseSha: string;
  expectedHeadSha: string;
  expectedHeadBranch: string;
  expectedPassed: boolean;
  profile: string;
  profileCommands: string[];
  loadWorkflow: (workflowPath: string) => Promise<{
    baseContent: string | undefined;
    headContent: string | undefined;
  }>;
  loadPackageJson: () => Promise<{
    baseContent: string | undefined;
    headContent: string | undefined;
  }>;
}

export interface ResolveGitHubActionsEvidenceResult {
  runId: number;
  workflowPath: string;
  workflowName: string;
  jobNames: string[];
  requiredStepNames: string[];
  passed: boolean;
  verification: string;
}

function leadingSpaces(line: string): number {
  if (/^\t+/.test(line)) {
    throw new Error("Trusted GitHub Actions workflow parsing does not support tab indentation");
  }
  return line.match(/^ */)?.[0].length ?? 0;
}

function yamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  const commentIndex = trimmed.indexOf(" #");
  return commentIndex >= 0 ? trimmed.slice(0, commentIndex).trim() : trimmed;
}

function workflowJobs(content: string): ParsedWorkflowJob[] {
  const lines = content.replace(/\r/g, "").split("\n");
  const jobsLine = lines.findIndex((line) => line.trim() === "jobs:");
  if (jobsLine < 0) throw new Error("Trusted GitHub Actions workflow does not contain jobs:");

  const jobsIndent = leadingSpaces(lines[jobsLine]!);
  let jobsEnd = lines.length;
  for (let index = jobsLine + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = leadingSpaces(line);
    if (indent <= jobsIndent) {
      jobsEnd = index;
      break;
    }
  }

  const candidateIndents: number[] = [];
  for (let index = jobsLine + 1; index < jobsEnd; index += 1) {
    const line = lines[index]!;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^[A-Za-z0-9_.-]+:\s*(?:#.*)?$/.test(line.trim())) {
      candidateIndents.push(leadingSpaces(line));
    }
  }
  if (candidateIndents.length === 0) {
    throw new Error("Trusted GitHub Actions workflow has no parseable jobs");
  }
  const jobIndent = Math.min(...candidateIndents.filter((value) => value > jobsIndent));
  if (!Number.isFinite(jobIndent)) {
    throw new Error("Trusted GitHub Actions workflow has no direct jobs children");
  }

  const starts: Array<{ index: number; id: string }> = [];
  for (let index = jobsLine + 1; index < jobsEnd; index += 1) {
    const line = lines[index]!;
    if (leadingSpaces(line) !== jobIndent) continue;
    const match = line.trim().match(/^([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (match) starts.push({ index, id: match[1]! });
  }

  return starts.map((start, position) => {
    const end = starts[position + 1]?.index ?? jobsEnd;
    let jobName = start.id;
    let stepsLine = -1;

    for (let index = start.index + 1; index < end; index += 1) {
      const line = lines[index]!;
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const indent = leadingSpaces(line);
      if (indent <= jobIndent) break;
      if (line.trim() === "steps:") {
        stepsLine = index;
        break;
      }
      const nameMatch = line.trim().match(/^name:\s*(.+)$/);
      if (nameMatch) jobName = yamlScalar(nameMatch[1]!);
    }

    const steps: ParsedWorkflowStep[] = [];
    if (stepsLine < 0) return { id: start.id, name: jobName, steps };

    const stepsIndent = leadingSpaces(lines[stepsLine]!);
    let current: ParsedWorkflowStep | undefined;

    for (let index = stepsLine + 1; index < end; index += 1) {
      const line = lines[index]!;
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const indent = leadingSpaces(line);
      if (indent <= stepsIndent) break;

      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        current = {};
        steps.push(current);
        const inline = trimmed.slice(2).trim();
        const nameMatch = inline.match(/^name:\s*(.+)$/);
        if (nameMatch) current.name = yamlScalar(nameMatch[1]!);
        const runMatch = inline.match(/^run:\s*(.*)$/);
        if (runMatch) current.run = yamlScalar(runMatch[1]!);
        continue;
      }

      if (!current) continue;
      const nameMatch = trimmed.match(/^name:\s*(.+)$/);
      if (nameMatch) {
        current.name = yamlScalar(nameMatch[1]!);
        continue;
      }

      const runMatch = trimmed.match(/^run:\s*(.*)$/);
      if (!runMatch) continue;
      const scalar = runMatch[1]!.trim();
      if (/^[|>][-+]?\s*$/.test(scalar)) {
        const runIndent = indent;
        const block: string[] = [];
        let blockIndex = index + 1;
        for (; blockIndex < end; blockIndex += 1) {
          const blockLine = lines[blockIndex]!;
          if (!blockLine.trim()) {
            block.push("");
            continue;
          }
          if (leadingSpaces(blockLine) <= runIndent) break;
          block.push(blockLine.trim());
        }
        current.run = block.join("\n");
        index = blockIndex - 1;
      } else {
        current.run = yamlScalar(scalar);
      }
    }

    return { id: start.id, name: jobName, steps };
  });
}

function trustedWorkflowJob(content: string, profileCommands: string[]): TrustedWorkflowJob {
  if (profileCommands.length === 0) {
    throw new Error("Trusted GitHub Actions evidence cannot verify an empty validation profile");
  }

  const candidates: TrustedWorkflowJob[] = [];
  for (const job of workflowJobs(content)) {
    const requiredStepNames: string[] = [];
    let valid = true;

    for (const command of profileCommands) {
      const matches = job.steps.filter(
        (step) => step.name && step.run && step.run.includes(command),
      );
      if (matches.length !== 1) {
        valid = false;
        break;
      }
      requiredStepNames.push(matches[0]!.name!);
    }

    if (valid) {
      candidates.push({
        jobName: job.name,
        requiredStepNames: [...new Set(requiredStepNames)],
      });
    }
  }

  if (candidates.length !== 1) {
    throw new Error(
      `Trusted GitHub Actions workflow must contain exactly one job mapping every validation command to one explicitly named run step; found ${candidates.length}`,
    );
  }
  return candidates[0]!;
}

export function parseGitHubActionsRunId(reference: string): number {
  const normalized = reference.trim();
  if (/^[1-9]\d*$/.test(normalized)) return Number(normalized);

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("github_ci reference must be an Actions run ID or github.com Actions run/job URL");
  }
  if (url.hostname.toLowerCase() !== "github.com") {
    throw new Error("github_ci reference URL must use github.com");
  }
  const match = url.pathname.match(/\/actions\/runs\/([1-9]\d*)(?:\/|$)/);
  if (!match) {
    throw new Error("github_ci reference URL does not contain an Actions run ID");
  }
  return Number(match[1]);
}

function jobNameMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.startsWith(`${expected} (`);
}

function referencedNpmScripts(commands: string[]): string[] {
  const scripts = new Set<string>();
  for (const command of commands) {
    const normalized = command.trim();
    if (normalized === "npm test" || normalized.startsWith("npm test ")) {
      scripts.add("test");
      continue;
    }
    const match = normalized.match(/^npm\s+run\s+([^\s]+)(?:\s|$)/);
    if (match) scripts.add(match[1]!);
  }
  return [...scripts];
}

function parsePackageScripts(content: string | undefined, refName: string): Record<string, string> {
  if (content === undefined) {
    throw new Error(`package.json is required at ${refName} to verify npm-based validation commands`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`package.json at ${refName} is invalid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`package.json at ${refName} must be an object`);
  }
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (scripts === undefined) return {};
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    throw new Error(`package.json scripts at ${refName} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

export class GitHubActionsValidationResolver {
  readonly #gh: GitHubActionsGhCommand;

  constructor(options: { command?: GitHubActionsGhCommand; ghBinary?: string } = {}) {
    const ghBinary = options.ghBinary?.trim() || "gh";
    this.#gh =
      options.command ??
      (async (args) => {
        const result = await execFileAsync(ghBinary, args, {
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, GH_PROMPT_DISABLED: "1" },
        });
        return String(result.stdout).trim();
      });
  }

  async #json<T>(args: string[]): Promise<T> {
    const output = await this.#gh(args);
    return JSON.parse(output) as T;
  }

  async resolve(input: ResolveGitHubActionsEvidenceInput): Promise<ResolveGitHubActionsEvidenceResult> {
    const runId = parseGitHubActionsRunId(input.reference);
    const run = await this.#json<ActionsRun>([
      "api",
      `repos/${input.repository}/actions/runs/${runId}`,
    ]);

    if (run.head_sha !== input.expectedHeadSha) {
      throw new Error(
        `GitHub Actions run ${runId} head SHA ${run.head_sha ?? "unknown"} does not match audited SHA ${input.expectedHeadSha}`,
      );
    }
    if (run.head_branch !== input.expectedHeadBranch) {
      throw new Error(
        `GitHub Actions run ${runId} head branch ${run.head_branch ?? "unknown"} does not match audited branch ${input.expectedHeadBranch}`,
      );
    }
    if (run.event !== "pull_request") {
      throw new Error(
        `GitHub Actions run ${runId} event must be pull_request, got ${run.event ?? "unknown"}`,
      );
    }
    const pull = (run.pull_requests ?? []).find(
      (candidate) => candidate.number === input.expectedPullNumber,
    );
    if (!pull) {
      throw new Error(
        `GitHub Actions run ${runId} is not associated with audited pull request #${input.expectedPullNumber}`,
      );
    }
    if (pull.head?.sha !== input.expectedHeadSha || pull.base?.sha !== input.expectedBaseSha) {
      throw new Error(
        `GitHub Actions run ${runId} pull request commit identity does not match audited base/head`,
      );
    }
    if (run.status !== "completed") {
      throw new Error(`GitHub Actions run ${runId} is not completed: ${run.status ?? "unknown"}`);
    }

    const actualPassed = run.conclusion === "success";
    if (actualPassed !== input.expectedPassed) {
      throw new Error(
        `GitHub Actions run ${runId} pass-state mismatch: submitted ${input.expectedPassed}, actual conclusion ${run.conclusion ?? "unknown"}`,
      );
    }

    const workflowPath = run.path?.trim();
    if (!workflowPath || !workflowPath.startsWith(".github/workflows/")) {
      throw new Error(
        `GitHub Actions run ${runId} returned an unsupported workflow path: ${workflowPath ?? "unknown"}`,
      );
    }

    const { baseContent, headContent } = await input.loadWorkflow(workflowPath);
    if (baseContent === undefined || headContent === undefined) {
      throw new Error(
        `GitHub Actions workflow ${workflowPath} must exist at both pinned base and audited head`,
      );
    }
    if (baseContent !== headContent) {
      throw new Error(
        `GitHub Actions workflow ${workflowPath} changed between pinned base and audited head and cannot be trusted for merge approval`,
      );
    }

    const npmScripts = referencedNpmScripts(input.profileCommands);
    if (npmScripts.length > 0) {
      const packageJson = await input.loadPackageJson();
      const baseScripts = parsePackageScripts(packageJson.baseContent, "pinned base");
      const headScripts = parsePackageScripts(packageJson.headContent, "audited head");
      for (const scriptName of npmScripts) {
        const baseScript = baseScripts[scriptName];
        const headScript = headScripts[scriptName];
        if (!baseScript || !headScript) {
          throw new Error(
            `npm validation script ${scriptName} must exist at both pinned base and audited head`,
          );
        }
        if (baseScript !== headScript) {
          throw new Error(
            `npm validation script ${scriptName} changed between pinned base and audited head and cannot be trusted for merge approval`,
          );
        }
      }
    }

    const trustedJob = trustedWorkflowJob(baseContent, input.profileCommands);
    const jobs = await this.#json<ActionsJobsResponse>([
      "api",
      `repos/${input.repository}/actions/runs/${runId}/jobs?per_page=100`,
    ]);
    const matchingJobs = (jobs.jobs ?? []).filter(
      (job) => typeof job.name === "string" && jobNameMatches(job.name, trustedJob.jobName),
    );
    if (matchingJobs.length === 0) {
      throw new Error(
        `GitHub Actions run ${runId} does not contain trusted job ${trustedJob.jobName}`,
      );
    }

    if (actualPassed) {
      for (const job of matchingJobs) {
        if (job.head_sha !== undefined && job.head_sha !== input.expectedHeadSha) {
          throw new Error(
            `GitHub Actions job ${job.name ?? "unknown"} head SHA does not match the audited SHA`,
          );
        }
        if (job.status !== "completed" || job.conclusion !== "success") {
          throw new Error(
            `GitHub Actions trusted job ${job.name ?? "unknown"} did not succeed`,
          );
        }
        for (const stepName of trustedJob.requiredStepNames) {
          const step = (job.steps ?? []).find((candidate) => candidate.name === stepName);
          if (!step || step.status !== "completed" || step.conclusion !== "success") {
            throw new Error(
              `GitHub Actions required validation step ${stepName} did not succeed in job ${job.name ?? "unknown"}`,
            );
          }
        }
      }
    }

    return {
      runId,
      workflowPath,
      workflowName: run.name?.trim() || workflowPath,
      jobNames: matchingJobs.map((job) => job.name ?? trustedJob.jobName),
      requiredStepNames: trustedJob.requiredStepNames,
      passed: actualPassed,
      verification:
        `Verified GitHub Actions run ${runId}: workflow=${workflowPath}, job=${trustedJob.jobName}, profile=${input.profile}, head=${input.expectedHeadSha}`,
    };
  }
}
