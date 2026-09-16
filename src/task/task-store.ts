import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TaskManifest } from "./task-types.js";
import { assertRunId, exists } from "./task-utils.js";

export class TaskStore {
  async findRunDir(repoRoot: string, runId: string): Promise<string> {
    assertRunId(runId);
    const tasksRoot = path.join(repoRoot, ".moon", "tasks");
    const branches = await readdir(tasksRoot, { withFileTypes: true }).catch(() => []);
    for (const branch of branches) {
      if (!branch.isDirectory()) continue;
      const candidate = path.join(tasksRoot, branch.name, runId);
      if (await exists(path.join(candidate, "manifest.json"))) return candidate;
    }
    throw new Error(`Unknown task run: ${runId}`);
  }

  async read(repoRoot: string, runId: string): Promise<TaskManifest> {
    const runDir = await this.findRunDir(repoRoot, runId);
    return JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")) as TaskManifest;
  }

  async write(manifest: TaskManifest): Promise<void> {
    manifest.updatedAt = new Date().toISOString();
    await mkdir(manifest.artifactDir, { recursive: true });
    await writeFile(path.join(manifest.artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
}
