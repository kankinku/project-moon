import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TaskValidationCommandResult } from "./task-types.js";
import { bounded } from "./task-utils.js";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT_CHARS = 100_000;

export async function runValidationCommand(
  repoRoot: string,
  command: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = {},
): Promise<TaskValidationCommandResult> {
  const started = Date.now();
  try {
    const result = await execFileAsync("/bin/bash", ["-lc", command], {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return {
      command,
      exitCode: 0,
      stdout: bounded(String(result.stdout), MAX_COMMAND_OUTPUT_CHARS).content,
      stderr: bounded(String(result.stderr), MAX_COMMAND_OUTPUT_CHARS).content,
      durationMs: Date.now() - started,
      timedOut: false,
    };
  } catch (error) {
    const failure = error as Error & {
      code?: number | string | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      killed?: boolean;
      signal?: string | null;
    };
    return {
      command,
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: bounded(String(failure.stdout ?? ""), MAX_COMMAND_OUTPUT_CHARS).content,
      stderr: bounded(String(failure.stderr ?? failure.message), MAX_COMMAND_OUTPUT_CHARS).content,
      durationMs: Date.now() - started,
      timedOut: failure.killed === true || failure.signal === "SIGTERM",
    };
  }
}
