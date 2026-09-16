#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const requestedRepo = argValue("--repo") ?? process.cwd();
const jsonOutput = process.argv.includes("--json");
const repoRoot = execFileSync("git", ["-C", requestedRepo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const configPath = process.env.MOON_CONFIG_PATH ? path.resolve(process.env.MOON_CONFIG_PATH) : path.join(repoRoot, "moon.config.json");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const knowledge = config.knowledge ?? {};
const maxPermanentDocs = Number.isInteger(knowledge.maxPermanentDocs) ? knowledge.maxPermanentDocs : 50;
const ephemeralPatterns = (knowledge.ephemeralPatterns ?? []).map((value) => new RegExp(String(value)));
const generatedPatterns = (knowledge.generatedPatterns ?? []).map((value) => new RegExp(String(value)));
const issues = [];

const trackedFiles = execFileSync("git", ["-C", repoRoot, "ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);
const untrackedFiles = execFileSync("git", ["-C", repoRoot, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);
const tracked = [...new Set([...trackedFiles, ...untrackedFiles])]
  .map((value) => value.replaceAll("\\", "/"))
  .sort();
const markdown = tracked.filter((file) => /\.md$/i.test(file) && existsSync(path.join(repoRoot, file)));
const generated = (file) => generatedPatterns.some((pattern) => pattern.test(file));
const ephemeral = (file) => ephemeralPatterns.some((pattern) => pattern.test(file));
const permanentDocs = markdown.filter((file) => !generated(file) && !ephemeral(file));

for (const file of markdown) {
  if (ephemeral(file)) {
    issues.push({ type: "ephemeral-doc", file, message: "tracked implementation/task document matches an ephemeral knowledge pattern" });
  }
}

if (permanentDocs.length > maxPermanentDocs) {
  issues.push({
    type: "document-budget",
    message: `permanent Markdown document count ${permanentDocs.length} exceeds configured limit ${maxPermanentDocs}`,
  });
}

function normalizeLinkTarget(raw) {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  const titleMatch = target.match(/^(\S+)(?:\s+["'][^"']*["'])$/);
  if (titleMatch?.[1]) target = titleMatch[1];
  return target;
}

function isExternal(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target);
}

for (const file of markdown) {
  const source = readFileSync(path.join(repoRoot, file), "utf8");
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of source.matchAll(linkPattern)) {
    const raw = normalizeLinkTarget(match[1] ?? "");
    if (!raw || isExternal(raw)) continue;
    const withoutFragment = raw.split("#", 1)[0]?.split("?", 1)[0] ?? "";
    if (!withoutFragment) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(withoutFragment);
    } catch {
      issues.push({ type: "invalid-link", file, target: raw, message: "local Markdown link contains invalid URL encoding" });
      continue;
    }
    const resolved = path.resolve(path.dirname(path.join(repoRoot, file)), decoded);
    const relative = path.relative(repoRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      issues.push({ type: "escaping-link", file, target: raw, message: "local Markdown link escapes repository root" });
      continue;
    }
    if (!existsSync(resolved)) {
      issues.push({ type: "broken-link", file, target: raw, message: "local Markdown link target does not exist" });
      continue;
    }
    try {
      statSync(resolved);
    } catch {
      issues.push({ type: "broken-link", file, target: raw, message: "local Markdown link target cannot be read" });
    }
  }
}

const result = {
  status: issues.length === 0 ? "PASS" : "FAIL",
  markdownFiles: markdown.length,
  permanentDocs: permanentDocs.length,
  maxPermanentDocs,
  issues,
};

if (jsonOutput) console.log(JSON.stringify(result, null, 2));
else if (issues.length === 0) {
  console.log(`docs_audit PASS markdown=${result.markdownFiles} permanent=${result.permanentDocs}/${maxPermanentDocs}`);
} else {
  console.error(`docs_audit FAIL issues=${issues.length} permanent=${result.permanentDocs}/${maxPermanentDocs}`);
  for (const issue of issues) console.error(`- [${issue.type}] ${issue.file ? `${issue.file}: ` : ""}${issue.message}${issue.target ? ` (${issue.target})` : ""}`);
}
process.exit(issues.length === 0 ? 0 : 1);
