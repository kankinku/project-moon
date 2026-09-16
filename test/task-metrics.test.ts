import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  failureSignature,
  recordValidationMetrics,
  validationMetricsSummary,
} from "../src/task/task-metrics.js";
import type { TaskValidationCommandResult } from "../src/task/task-types.js";

function result(overrides: Partial<TaskValidationCommandResult> = {}): TaskValidationCommandResult {
  return {
    command: "npm test",
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    durationMs: 100,
    timedOut: false,
    ...overrides,
  };
}

describe("task validation metrics", () => {
  it("normalizes volatile failure output into a repeatable signature", () => {
    const first = failureSignature(result({
      exitCode: 1,
      stdout: 'requestId":"11111111-1111-4111-8111-111111111111" failed in 123ms /tmp/run-a',
    }));
    const second = failureSignature(result({
      exitCode: 1,
      stdout: 'requestId":"22222222-2222-4222-8222-222222222222" failed in 987ms /tmp/run-b',
    }));
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("detects repeated failures and validation runtime regressions without storing raw output", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "moon-task-metrics-"));
    await recordValidationMetrics(repo, "baseline-1", [result({ durationMs: 100 })]);
    await recordValidationMetrics(repo, "baseline-2", [result({ durationMs: 110 })]);
    await recordValidationMetrics(repo, "baseline-3", [result({ durationMs: 90 })]);

    const slow = await recordValidationMetrics(repo, "current", [result({ durationMs: 1200 })]);
    expect(slow.performanceRegressions).toEqual([
      expect.objectContaining({ command: "npm test", baselineMedianMs: 100, durationMs: 1200 }),
    ]);

    const failed = result({ exitCode: 1, stdout: "same deterministic assertion failed in 10ms" });
    const firstFailure = await recordValidationMetrics(repo, "failure-1", [failed]);
    expect(firstFailure.repeatedFailures).toEqual([]);
    const secondFailure = await recordValidationMetrics(repo, "failure-2", [
      { ...failed, stdout: "same deterministic assertion failed in 99ms" },
    ]);
    expect(secondFailure.repeatedFailures[0]).toMatchObject({ command: "npm test", count: 2 });

    const summary = await validationMetricsSummary(repo, "failure-2");
    expect(summary).toMatchObject({
      failedCommands: 1,
      repeatedFailureEvents: 1,
      regressionRecommended: true,
    });
  });
});
