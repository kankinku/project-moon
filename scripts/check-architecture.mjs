#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const requestedRepo = argValue("--repo") ?? process.cwd();
const jsonOutput = process.argv.includes("--json");
const repoRoot = execFileSync("git", ["-C", requestedRepo, "rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const configPath = path.join(repoRoot, "moon.config.json");

if (!existsSync(configPath)) {
  console.log(jsonOutput ? JSON.stringify({ status: "SKIP", reason: "moon.config.json not found" }) : "architecture_check SKIP: moon.config.json not found");
  process.exit(0);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const architecture = config.architecture;
if (!architecture) {
  console.log(jsonOutput ? JSON.stringify({ status: "SKIP", reason: "architecture config not defined" }) : "architecture_check SKIP: architecture config not defined");
  process.exit(0);
}

const layers = Array.isArray(architecture.layers) ? architecture.layers : [];
const deny = Array.isArray(architecture.deny) ? architecture.deny : [];
const maxFileLines = Array.isArray(architecture.maxFileLines) ? architecture.maxFileLines : [];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const issues = [];

function compilePattern(value, label) {
  try {
    return new RegExp(value);
  } catch {
    issues.push({ type: "config", message: `invalid regex for ${label}: ${value}` });
    return /$a/;
  }
}

const compiledLayers = layers.map((layer) => ({
  name: String(layer.name ?? ""),
  patterns: (Array.isArray(layer.patterns) ? layer.patterns : []).map((pattern) => compilePattern(String(pattern), `layer ${layer.name}`)),
}));
const compiledMaxLines = maxFileLines.map((rule) => ({
  pattern: compilePattern(String(rule.pattern ?? ""), "maxFileLines"),
  max: Number(rule.max),
}));

for (const layer of compiledLayers) {
  if (!layer.name || layer.patterns.length === 0) issues.push({ type: "config", message: "each architecture layer needs a name and at least one pattern" });
}
for (const rule of deny) {
  if (!compiledLayers.some((layer) => layer.name === rule.from) || !compiledLayers.some((layer) => layer.name === rule.to)) {
    issues.push({ type: "config", message: `deny rule references unknown layer: ${rule.from} -> ${rule.to}` });
  }
}
for (const rule of compiledMaxLines) {
  if (!Number.isInteger(rule.max) || rule.max <= 0) issues.push({ type: "config", message: "maxFileLines.max must be a positive integer" });
}

const tracked = execFileSync("git", ["-C", repoRoot, "ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .map((value) => value.replaceAll("\\", "/"));
const trackedSet = new Set(tracked);
const sourceFiles = tracked.filter((file) => sourceExtensions.has(path.posix.extname(file)));

function layerFor(file) {
  const matches = compiledLayers.filter((layer) => layer.patterns.some((pattern) => pattern.test(file)));
  if (matches.length > 1) {
    issues.push({ type: "classification", file, message: `file matches multiple architecture layers: ${matches.map((layer) => layer.name).join(", ")}` });
  }
  return matches[0]?.name;
}

const layerMap = new Map(sourceFiles.map((file) => [file, layerFor(file)]));

function importSpecifiers(source) {
  const values = [];
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) if (match[1]) values.push(match[1]);
  }
  return [...new Set(values)];
}

function resolveRelative(fromFile, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates = [base];
  const ext = path.posix.extname(base);
  if (ext) {
    const stem = base.slice(0, -ext.length);
    if ([".js", ".mjs", ".cjs", ".jsx"].includes(ext)) {
      candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${stem}.cjs`);
    }
  } else {
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`);
    candidates.push(`${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.mjs`, `${base}/index.cjs`);
  }
  return candidates.find((candidate) => trackedSet.has(candidate));
}

let importCount = 0;
for (const file of sourceFiles) {
  const absolute = path.join(repoRoot, file);
  const source = readFileSync(absolute, "utf8");
  const fromLayer = layerMap.get(file);
  for (const specifier of importSpecifiers(source)) {
    const target = resolveRelative(file, specifier);
    if (!target) continue;
    importCount += 1;
    const toLayer = layerMap.get(target);
    if (!fromLayer || !toLayer) continue;
    const forbidden = deny.some((rule) => rule.from === fromLayer && rule.to === toLayer);
    if (forbidden) {
      issues.push({
        type: "dependency",
        file,
        target,
        message: `forbidden architecture dependency: ${fromLayer} -> ${toLayer}`,
      });
    }
  }

  const lineCount = source.length === 0 ? 0 : source.split(/\r?\n/).length;
  for (const rule of compiledMaxLines) {
    if (rule.pattern.test(file) && lineCount > rule.max) {
      issues.push({ type: "size", file, message: `file has ${lineCount} lines; configured maximum is ${rule.max}` });
    }
  }
}

const result = {
  status: issues.length === 0 ? "PASS" : "FAIL",
  filesChecked: sourceFiles.length,
  classifiedFiles: [...layerMap.values()].filter(Boolean).length,
  importsChecked: importCount,
  issues,
};

if (jsonOutput) console.log(JSON.stringify(result, null, 2));
else if (issues.length === 0) console.log(`architecture_check PASS files=${result.filesChecked} classified=${result.classifiedFiles} imports=${result.importsChecked}`);
else {
  console.error(`architecture_check FAIL issues=${issues.length}`);
  for (const issue of issues) console.error(`- [${issue.type}] ${issue.file ? `${issue.file}: ` : ""}${issue.message}${issue.target ? ` (${issue.target})` : ""}`);
}
process.exit(issues.length === 0 ? 0 : 1);
