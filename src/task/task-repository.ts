import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { TaskManifest } from "./task-types.js";
import { bounded, exists, unique } from "./task-utils.js";

const execFileAsync = promisify(execFile);
const MAX_POLICY_CHARS = 60_000;
const MAX_TRACKED_FILES = 160;

export class TaskRepository {
  async command(executable: string, args: string[], options: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {}) {
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  }

  async git(repoPath: string, args: string[]): Promise<string> {
    const result = await this.command("git", ["-C", repoPath, ...args]);
    return result.stdout.trimEnd();
  }

  async root(repoPath: string): Promise<string> {
    const root = await this.git(repoPath, ["rev-parse", "--show-toplevel"]);
    if (!root) throw new Error(`Not a Git repository: ${repoPath}`);
    return path.resolve(root);
  }

  async ensureLocalIgnore(repoRoot: string): Promise<void> {
    const excludePath = (await this.git(repoRoot, ["rev-parse", "--git-path", "info/exclude"])) || ".git/info/exclude";
    const absolute = path.isAbsolute(excludePath) ? excludePath : path.join(repoRoot, excludePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const current = (await exists(absolute)) ? await readFile(absolute, "utf8") : "";
    if (!current.split(/\r?\n/).includes(".moon/")) {
      await appendFile(absolute, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}.moon/\n`, "utf8");
    }
  }

  async trackedFiles(repoRoot: string): Promise<string[]> {
    const trackedRaw = await this.git(repoRoot, ["ls-files"]);
    return trackedRaw ? trackedRaw.split("\n").filter(Boolean).sort() : [];
  }

  async discover(repoRoot: string, configFile?: string): Promise<TaskManifest["discovery"]> {
    const topLevelEntries = (await readdir(repoRoot)).filter((entry) => entry !== ".git").sort();
    const allTracked = await this.trackedFiles(repoRoot);
    const packageScripts: Record<string, string> = {};
    const packagePath = path.join(repoRoot, "package.json");
    if (await exists(packagePath)) {
      const pkg = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, string> };
      Object.assign(packageScripts, pkg.scripts ?? {});
    }
    const candidatePolicies = [
      "AGENTS.md", "docs/adr.yaml", "docs/code-convention.yaml", "docs/architecture.yaml",
      "docs/domain-invariants.yaml", "moon.config.json",
    ];
    const policyFiles: string[] = [];
    for (const relative of candidatePolicies) {
      if (await exists(path.join(repoRoot, relative))) policyFiles.push(relative);
    }
    return {
      topLevelEntries,
      trackedFileCount: allTracked.length,
      trackedFiles: allTracked.slice(0, MAX_TRACKED_FILES),
      packageScripts,
      policyFiles,
      configFile,
    };
  }

  async changedPaths(repoRoot: string, baseSha: string): Promise<string[]> {
    const commands = [
      ["diff", "--name-only", `${baseSha}..HEAD`],
      ["diff", "--name-only"],
      ["diff", "--cached", "--name-only"],
      ["ls-files", "--others", "--exclude-standard"],
    ];
    const paths: string[] = [];
    for (const args of commands) {
      const output = await this.git(repoRoot, args);
      if (output) paths.push(...output.split("\n").filter(Boolean));
    }
    return unique(paths).sort();
  }

  async fingerprint(repoRoot: string): Promise<string> {
    const hash = createHash("sha256");
    const head = await this.git(repoRoot, ["rev-parse", "HEAD"]);
    const diff = await this.git(repoRoot, ["diff", "--binary", "HEAD"]);
    const cached = await this.git(repoRoot, ["diff", "--cached", "--binary", "HEAD"]);
    hash.update(`HEAD\0${head}\0DIFF\0${diff}\0CACHED\0${cached}\0`);
    const untrackedRaw = await this.git(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
    const untracked = untrackedRaw ? untrackedRaw.split("\n").filter(Boolean).sort() : [];
    for (const relative of untracked) {
      const absolute = path.join(repoRoot, relative);
      const stat = await lstat(absolute);
      hash.update(`UNTRACKED\0${relative}\0${stat.mode}\0`);
      if (stat.isSymbolicLink()) hash.update(`LINK\0${await readlink(absolute)}\0`);
      else if (stat.isFile()) hash.update(await readFile(absolute));
      else hash.update(`TYPE\0${stat.mode}\0`);
    }
    return hash.digest("hex");
  }

  async policyContext(repoRoot: string, policyFiles: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const relative of policyFiles) {
      const content = await readFile(path.join(repoRoot, relative), "utf8").catch(() => "");
      if (content) result[relative] = bounded(content, MAX_POLICY_CHARS).content;
    }
    return result;
  }
}
