import { readFile } from "node:fs/promises";
import path from "node:path";

import type { MoonHarnessConfig } from "./task-types.js";
import { exists, unique } from "./task-utils.js";

const DEFAULT_CONFIG: MoonHarnessConfig = {
  schemaVersion: 1,
  validation: {
    profileOrder: ["fast", "normal", "release"],
    profiles: { fast: [], normal: [], release: [] },
    riskProfiles: { low: "fast", medium: "normal", high: "release" },
  },
  risk: {
    highPathPatterns: [
      "(^|/)(auth|oauth|security)(/|\\.|$)",
      "^(deploy|tunneling|migrations?)/",
      "(^|/)(Dockerfile|docker-compose[^/]*\\.ya?ml)$",
      "^(Start-PublicMcp|Stop-PublicMcp|Get-OAuthApprovalKey)\\.ps1$",
      "^\\.github/workflows/",
    ],
    mediumPathPatterns: ["^src/", "^package(-lock)?\\.json$", "^tsconfig\\.json$", "^test/"],
    highKeywords: [
      "auth", "oauth", "token", "secret", "security", "permission", "deploy", "production",
      "migration", "database", "delete", "network", "인증", "권한", "배포", "마이그레이션",
      "보안", "비밀", "삭제", "네트워크",
    ],
    mediumKeywords: [
      "api", "dependency", "refactor", "service", "schema", "feature",
      "기능", "리팩터링", "의존성", "스키마",
    ],
  },
};

function cloneDefaultConfig(): MoonHarnessConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as MoonHarnessConfig;
}

function assertConfig(config: MoonHarnessConfig): void {
  if (config.validation.profileOrder.length === 0) throw new Error("validation.profileOrder must not be empty");
  for (const profile of config.validation.profileOrder) {
    if (!Array.isArray(config.validation.profiles[profile])) throw new Error(`Validation profile is missing: ${profile}`);
  }
  for (const risk of ["low", "medium", "high"] as const) {
    const profile = config.validation.riskProfiles[risk];
    if (!config.validation.profileOrder.includes(profile)) {
      throw new Error(`Risk profile ${risk} references unknown validation profile: ${profile}`);
    }
  }
  for (const pattern of [...config.risk.highPathPatterns, ...config.risk.mediumPathPatterns]) {
    try {
      new RegExp(pattern, "i");
    } catch {
      throw new Error(`Invalid risk path regex in moon.config.json: ${pattern}`);
    }
  }
}

export async function loadHarnessConfig(repoRoot: string): Promise<{ config: MoonHarnessConfig; configFile?: string }> {
  const config = cloneDefaultConfig();
  const configPath = path.join(repoRoot, "moon.config.json");
  if (await exists(configPath)) {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as Partial<MoonHarnessConfig>;
    if (parsed.schemaVersion !== 1) throw new Error("moon.config.json schemaVersion must be 1");
    if (parsed.validation?.profiles) config.validation.profiles = parsed.validation.profiles;
    if (parsed.validation?.profileOrder) config.validation.profileOrder = parsed.validation.profileOrder;
    if (parsed.validation?.riskProfiles) {
      config.validation.riskProfiles = { ...config.validation.riskProfiles, ...parsed.validation.riskProfiles };
    }
    if (parsed.risk) config.risk = { ...config.risk, ...parsed.risk };
    assertConfig(config);
    return { config, configFile: "moon.config.json" };
  }

  const packagePath = path.join(repoRoot, "package.json");
  if (await exists(packagePath)) {
    const pkg = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const candidate = (name: string): string | undefined => scripts[name] ? `npm run ${name}` : undefined;
    config.validation.profiles.fast = unique([candidate("typecheck") ?? candidate("test") ?? candidate("build") ?? ""]);
    config.validation.profiles.normal = unique([candidate("typecheck") ?? "", candidate("test") ?? ""]);
    config.validation.profiles.release = unique([candidate("typecheck") ?? "", candidate("test") ?? "", candidate("build") ?? ""]);
  }
  assertConfig(config);
  return { config };
}
