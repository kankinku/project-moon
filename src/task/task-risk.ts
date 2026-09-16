import type { MoonHarnessConfig, TaskRiskAssessment, TaskRiskLevel } from "./task-types.js";
import { maxRisk, unique } from "./task-utils.js";

export function classifyRisk(
  config: MoonHarnessConfig,
  request: string,
  changedPaths: string[],
  hint?: TaskRiskLevel,
): TaskRiskAssessment {
  let level: TaskRiskLevel = "low";
  const reasons: string[] = [];
  const normalizedRequest = request.toLowerCase();

  for (const keyword of config.risk.highKeywords) {
    if (normalizedRequest.includes(keyword.toLowerCase())) {
      level = "high";
      reasons.push(`request keyword matched high risk: ${keyword}`);
    }
  }
  if (level !== "high") {
    for (const keyword of config.risk.mediumKeywords) {
      if (normalizedRequest.includes(keyword.toLowerCase())) {
        level = "medium";
        reasons.push(`request keyword matched medium risk: ${keyword}`);
      }
    }
  }

  for (const relative of changedPaths) {
    if (config.risk.highPathPatterns.some((pattern) => new RegExp(pattern, "i").test(relative))) {
      level = "high";
      reasons.push(`high-risk path changed: ${relative}`);
      continue;
    }
    if (level !== "high" && config.risk.mediumPathPatterns.some((pattern) => new RegExp(pattern, "i").test(relative))) {
      level = "medium";
      reasons.push(`medium-risk path changed: ${relative}`);
    }
  }

  if (hint) {
    const raised = maxRisk(level, hint);
    if (raised !== level) reasons.push(`risk hint raised level to ${hint}`);
    level = raised;
  }
  if (reasons.length === 0) reasons.push("no medium/high risk trigger matched");
  return { level, reasons: unique(reasons), hint };
}
