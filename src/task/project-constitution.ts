import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

type Entry = {root: string; origin: string; required: string[]};
type Registry = {schemaVersion: number; projects: Record<string, Entry>};
export type VerifiedProjectConstitution = {
  project: string; root: string; policyDigest: string;
  policies: Record<string, string>;
};

function normalizeOrigin(value: string): string {
  return value.toLowerCase().replace(/^git@github[.]com:/, "https://github.com/")
    .replace(/[/]+$/, "").replace(/[.]git$/, "");
}

export async function loadProjectConstitution(
  repoRoot: string,
  origin: string,
  registryPath = "/shared/.agent/PROJECTS.json",
): Promise<VerifiedProjectConstitution | undefined> {
  let parsed: Registry;
  try {
    parsed = JSON.parse(await readFile(registryPath, "utf8")) as Registry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Invalid Moon project registry: " + String(error));
  }
  if (parsed.schemaVersion !== 1 || !parsed.projects || typeof parsed.projects !== "object") {
    throw new Error("Invalid Moon project registry schema");
  }
  const entry = Object.entries(parsed.projects).find(([, v]) =>
    v && normalizeOrigin(v.origin ?? "") === normalizeOrigin(origin) && Boolean(origin));
  if (!entry) return undefined;

  const [project, definition] = entry;
  if (path.resolve(definition.root) !== path.resolve(repoRoot)) {
    throw new Error("PROJECT_ROOT_MISMATCH: " + project + " must start at " + definition.root);
  }
  const required = definition.required;
  if (!Array.isArray(required) || !required.includes("AGENTS.md") ||
    !required.includes(".agent/CONSTITUTION.md")) {
    throw new Error("PROJECT_POLICY_INVALID: " + project);
  }
  const policies: Record<string, string> = {};
  for (const relative of required) {
    if (!relative || path.isAbsolute(relative) || relative.split("/").includes("..")) {
      throw new Error("PROJECT_POLICY_INVALID_PATH: " + project);
    }
    const file = path.join(repoRoot, relative);
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not regular");
      const content = await readFile(file, "utf8");
      if (!content.trim() || content.length > 90000) throw new Error("empty/oversized");
      policies[relative] = content;
    } catch {
      throw new Error("PROJECT_CONSTITUTION_REQUIRED: " + project + "/" + relative);
    }
  }
  const policyDigest = createHash("sha256").update(JSON.stringify(policies)).digest("hex");
  return {project,root:repoRoot,policyDigest,policies};
}


export async function verifyProjectConstitution(
  root: string,
  git: (args: string[]) => Promise<string>,
): Promise<VerifiedProjectConstitution | undefined> {
  const origin = await git(["remote", "get-url", "origin"]).catch(() => "");
  const constitution = await loadProjectConstitution(root, origin);
  if (!constitution) return undefined;

  let behind: number;
  try {
    await git(["fetch", "--prune", "origin", "main"]);
    behind = Number(await git(["rev-list", "--count", "HEAD..origin/main"]));
  } catch (error) {
    throw new Error("PROJECT_GIT_UNVERIFIED: " + constitution.project, { cause: error });
  }
  if (!Number.isSafeInteger(behind) || behind > 0) {
    throw new Error("PROJECT_GIT_STALE: " + constitution.project + " is " + behind + " commit(s) behind origin/main");
  }
  return constitution;
}
