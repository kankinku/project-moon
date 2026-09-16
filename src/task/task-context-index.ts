import path from "node:path";

import type { TaskRepository } from "./task-repository.js";

export type RepositoryFileKind = "source" | "test" | "docs" | "config" | "other";

export interface RepositoryIndexFile {
  path: string;
  kind: RepositoryFileKind;
  module: string;
}

export interface RepositoryModuleSummary {
  name: string;
  files: number;
  source: number;
  tests: number;
  docs: number;
  config: number;
}

export interface TaskRepositoryIndex {
  schemaVersion: 1;
  headSha: string;
  generatedAt: string;
  counts: Record<RepositoryFileKind | "total", number>;
  modules: RepositoryModuleSummary[];
  files: RepositoryIndexFile[];
}

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".kts",
  ".cs", ".cpp", ".cc", ".c", ".h", ".hpp", ".rb", ".php", ".swift", ".scala", ".sh", ".ps1",
]);
const CONFIG_BASENAMES = new Set([
  "package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "vite.config.ts", "webpack.config.js",
  "dockerfile", "docker-compose.yml", "docker-compose.yaml", "makefile", "cargo.toml", "go.mod", "pyproject.toml",
  "requirements.txt", "moon.config.json",
]);
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "into", "update", "change", "improve", "system",
  "feature", "task", "code", "project", "작업", "기능", "개선", "수정", "시스템", "코드", "프로젝트", "구현",
]);

function normalized(relative: string): string {
  return relative.replaceAll("\\", "/");
}

function fileKind(relative: string): RepositoryFileKind {
  const file = normalized(relative);
  const lower = file.toLowerCase();
  const basename = path.posix.basename(lower);
  const ext = path.posix.extname(lower);
  if (
    /(^|\/)(test|tests|__tests__)(\/|$)/.test(lower) ||
    /\.(?:test|spec)\.[^.]+$/.test(lower)
  ) return "test";
  if (/\.mdx?$/.test(lower) || /(^|\/)docs?(\/|$)/.test(lower)) return "docs";
  if (
    CONFIG_BASENAMES.has(basename) ||
    /^\.[^/]+rc(?:\.[^/]+)?$/.test(basename) ||
    /\.(?:ya?ml|toml|ini)$/.test(lower)
  ) return "config";
  if (SOURCE_EXTENSIONS.has(ext)) return "source";
  return "other";
}

function moduleName(relative: string): string {
  const parts = normalized(relative).split("/").filter(Boolean);
  if (parts.length <= 1) return "root";
  if (["src", "lib", "app", "apps", "packages", "services", "modules"].includes(parts[0] ?? "") && parts.length >= 3) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (["test", "tests", "docs", "deploy", "scripts", "harnesses", "vendor"].includes(parts[0] ?? "")) {
    return parts[0] ?? "root";
  }
  return parts[0] ?? "root";
}

function queryTerms(query: string): string[] {
  const matches = query.toLowerCase().match(/[\p{L}\p{N}_.-]{2,}/gu) ?? [];
  return [...new Set(matches.filter((term) => !STOP_WORDS.has(term)))];
}

function relevanceScore(file: RepositoryIndexFile, terms: string[]): number {
  const lower = file.path.toLowerCase();
  const basename = path.posix.basename(lower);
  const segments = lower.split(/[\/._-]+/g);
  let score = /^(package\.json|moon\.config\.json|tsconfig\.json)$/.test(lower) ? 1 : 0;
  for (const term of terms) {
    if (basename === term || basename.startsWith(`${term}.`) || basename.startsWith(`${term}-`)) score += 12;
    else if (segments.includes(term)) score += 8;
    else if (lower.includes(term)) score += 4;
  }
  return score;
}

export async function buildRepositoryIndex(
  repository: TaskRepository,
  repoRoot: string,
  headSha: string,
): Promise<TaskRepositoryIndex> {
  const tracked = await repository.trackedFiles(repoRoot);
  const files = tracked.map((relative) => {
    const file = normalized(relative);
    return { path: file, kind: fileKind(file), module: moduleName(file) } satisfies RepositoryIndexFile;
  });

  const counts: TaskRepositoryIndex["counts"] = {
    total: files.length,
    source: 0,
    test: 0,
    docs: 0,
    config: 0,
    other: 0,
  };
  const moduleMap = new Map<string, RepositoryModuleSummary>();
  for (const file of files) {
    counts[file.kind] += 1;
    const summary = moduleMap.get(file.module) ?? {
      name: file.module,
      files: 0,
      source: 0,
      tests: 0,
      docs: 0,
      config: 0,
    };
    summary.files += 1;
    if (file.kind === "source") summary.source += 1;
    if (file.kind === "test") summary.tests += 1;
    if (file.kind === "docs") summary.docs += 1;
    if (file.kind === "config") summary.config += 1;
    moduleMap.set(file.module, summary);
  }

  return {
    schemaVersion: 1,
    headSha,
    generatedAt: new Date().toISOString(),
    counts,
    modules: [...moduleMap.values()].sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)),
    files,
  };
}

export function repositoryContextSummary(
  index: TaskRepositoryIndex,
  query: string,
  maxRelevantFiles = 40,
): Record<string, unknown> {
  const terms = queryTerms(query);
  const ranked = index.files
    .map((file) => ({ file, score: relevanceScore(file, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  const fallback = ranked.length === 0
    ? index.files
        .filter((file) => ["source", "test", "config"].includes(file.kind))
        .slice(0, Math.min(maxRelevantFiles, 20))
        .map((file) => ({ file, score: 0 }))
    : [];
  const relevantFiles = [...ranked, ...fallback]
    .slice(0, maxRelevantFiles)
    .map(({ file, score }) => ({ path: file.path, kind: file.kind, module: file.module, score }));

  return {
    headSha: index.headSha,
    counts: index.counts,
    modules: index.modules.slice(0, 30),
    queryTerms: terms,
    relevantFiles,
    relevantFileLimit: maxRelevantFiles,
  };
}
