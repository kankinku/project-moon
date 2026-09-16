import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { TaskValidationCommandResult } from "./task-types.js";

interface ValidationMetricEvent {
  schemaVersion: 1;
  at: string;
  runId: string;
  commandHash: string;
  passed: boolean;
  durationMs: number;
  failureSignature?: string;
  repeatedFailure: boolean;
  performanceRegression: boolean;
}

export interface RepeatedFailureInsight {
  signature: string;
  command: string;
  count: number;
}

export interface PerformanceRegressionInsight {
  command: string;
  durationMs: number;
  baselineMedianMs: number;
  ratio: number;
  samples: number;
}

export interface ValidationInsights {
  repeatedFailures: RepeatedFailureInsight[];
  performanceRegressions: PerformanceRegressionInsight[];
}

export interface ValidationMetricsSummary {
  events: number;
  failedCommands: number;
  repeatedFailureEvents: number;
  performanceRegressionEvents: number;
  regressionRecommended: boolean;
}

const PERFORMANCE_MIN_SAMPLES = 3;
const PERFORMANCE_RATIO = 1.5;
const PERFORMANCE_MIN_DELTA_MS = 500;
const MAX_BASELINE_SAMPLES = 10;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeFailureOutput(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\b\d+(?:\.\d+)?\s*ms\b/gi, "<duration>")
    .replace(/\/tmp\/[A-Za-z0-9._-]+/g, "/tmp/<temp>")
    .replace(/"requestId":"[^"]+"/g, '"requestId":"<request>"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

export function failureSignature(result: TaskValidationCommandResult): string | undefined {
  if (result.exitCode === 0 && !result.timedOut) return undefined;
  const normalized = normalizeFailureOutput(`${result.stdout}\n${result.stderr}`);
  return hash(`${hash(result.command)}\0${result.exitCode}\0${result.timedOut}\0${normalized}`);
}

function metricsPath(repoRoot: string): string {
  return path.join(repoRoot, ".moon", "metrics", "validation-events.ndjson");
}

async function readEvents(repoRoot: string): Promise<ValidationMetricEvent[]> {
  const content = await readFile(metricsPath(repoRoot), "utf8").catch(() => "");
  const events: ValidationMetricEvent[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ValidationMetricEvent;
      if (parsed.schemaVersion === 1 && typeof parsed.commandHash === "string") events.push(parsed);
    } catch {
      // Ignore a malformed/incomplete event instead of making quality metrics a task blocker.
    }
  }
  return events;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return sorted[middle] ?? 0;
}

export async function recordValidationMetrics(
  repoRoot: string,
  runId: string,
  results: TaskValidationCommandResult[],
): Promise<ValidationInsights> {
  const previous = await readEvents(repoRoot);
  const repeatedFailures: RepeatedFailureInsight[] = [];
  const performanceRegressions: PerformanceRegressionInsight[] = [];
  const newEvents: ValidationMetricEvent[] = [];

  for (const result of results) {
    const commandHash = hash(result.command);
    const passed = result.exitCode === 0 && !result.timedOut;
    const signature = failureSignature(result);
    const priorSameFailure = signature
      ? previous.filter((event) => event.failureSignature === signature).length
      : 0;
    const repeatedFailure = Boolean(signature && priorSameFailure >= 1);
    if (signature && repeatedFailure) {
      repeatedFailures.push({ signature, command: result.command, count: priorSameFailure + 1 });
    }

    const baselineDurations = previous
      .filter((event) => event.commandHash === commandHash && event.passed)
      .slice(-MAX_BASELINE_SAMPLES)
      .map((event) => event.durationMs);
    let performanceRegression = false;
    if (passed && baselineDurations.length >= PERFORMANCE_MIN_SAMPLES) {
      const baselineMedianMs = median(baselineDurations);
      const ratio = baselineMedianMs > 0 ? result.durationMs / baselineMedianMs : 0;
      if (ratio >= PERFORMANCE_RATIO && result.durationMs - baselineMedianMs >= PERFORMANCE_MIN_DELTA_MS) {
        performanceRegression = true;
        performanceRegressions.push({
          command: result.command,
          durationMs: result.durationMs,
          baselineMedianMs,
          ratio: Number(ratio.toFixed(2)),
          samples: baselineDurations.length,
        });
      }
    }

    newEvents.push({
      schemaVersion: 1,
      at: new Date().toISOString(),
      runId,
      commandHash,
      passed,
      durationMs: result.durationMs,
      failureSignature: signature,
      repeatedFailure,
      performanceRegression,
    });
  }

  const target = metricsPath(repoRoot);
  await mkdir(path.dirname(target), { recursive: true });
  if (newEvents.length > 0) {
    await appendFile(target, `${newEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  }
  return { repeatedFailures, performanceRegressions };
}

export async function validationMetricsSummary(
  repoRoot: string,
  runId: string,
): Promise<ValidationMetricsSummary> {
  const events = (await readEvents(repoRoot)).filter((event) => event.runId === runId);
  const failedCommands = events.filter((event) => !event.passed).length;
  const repeatedFailureEvents = events.filter((event) => event.repeatedFailure).length;
  const performanceRegressionEvents = events.filter((event) => event.performanceRegression).length;
  return {
    events: events.length,
    failedCommands,
    repeatedFailureEvents,
    performanceRegressionEvents,
    regressionRecommended: repeatedFailureEvents > 0,
  };
}
