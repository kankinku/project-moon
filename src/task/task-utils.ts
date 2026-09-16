import { access } from "node:fs/promises";

import type { TaskRiskLevel } from "./task-types.js";

export function bounded(value: string, maxChars: number): { content: string; truncated: boolean } {
  if (value.length <= maxChars) return { content: value, truncated: false };
  return { content: `${value.slice(0, maxChars)}\n\n[truncated by Project Moon]`, truncated: true };
}

export function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "detached";
}

export function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("runId contains unsupported characters");
}

export async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function maxRisk(a: TaskRiskLevel, b: TaskRiskLevel): TaskRiskLevel {
  const rank: Record<TaskRiskLevel, number> = { low: 0, medium: 1, high: 2 };
  return rank[a] >= rank[b] ? a : b;
}
