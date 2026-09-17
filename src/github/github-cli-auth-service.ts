import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEVICE_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/i;
const DEVICE_URL = "https://github.com/login/device";

interface AuthSession {
  id: string;
  process: ChildProcessWithoutNullStreams;
  output: string;
  userCode?: string;
  startedAt: string;
  completed: boolean;
  exitCode?: number | null;
}

export class GitHubCliAuthService {
  readonly #ghBinary: string;
  readonly #expectedAuditorLogin?: string;
  #session?: AuthSession;

  constructor(options: { ghBinary?: string; expectedAuditorLogin?: string } = {}) {
    this.#ghBinary = options.ghBinary?.trim() || "gh";
    this.#expectedAuditorLogin = options.expectedAuditorLogin?.trim().toLowerCase() || undefined;
  }

  async #currentLogin(): Promise<string | undefined> {
    try {
      const result = await execFileAsync(this.#ghBinary, ["api", "user", "--jq", ".login"], {
        encoding: "utf8",
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      });
      return String(result.stdout).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async start(): Promise<Record<string, unknown>> {
    const existingLogin = await this.#currentLogin();
    if (existingLogin) {
      const matchesExpected = this.#expectedAuditorLogin
        ? existingLogin.toLowerCase() === this.#expectedAuditorLogin
        : undefined;
      if (matchesExpected === false) {
        throw new Error(
          `Authenticated gh account ${existingLogin} does not match expected merge auditor ${this.#expectedAuditorLogin}`,
        );
      }
      return {
        state: "AUTHENTICATED",
        account: existingLogin,
        expectedAccount: this.#expectedAuditorLogin,
        matchesExpected,
      };
    }

    if (this.#session && !this.#session.completed) {
      if (!this.#session.userCode) {
        throw new Error("A GitHub authentication session is already starting");
      }
      return {
        state: "PENDING",
        authorizationId: this.#session.id,
        verificationUri: DEVICE_URL,
        userCode: this.#session.userCode,
        startedAt: this.#session.startedAt,
      };
    }

    const child = spawn(
      this.#ghBinary,
      [
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--git-protocol",
        "https",
        "--web",
        "--skip-ssh-key",
      ],
      {
        env: {
          ...process.env,
          BROWSER: process.env.BROWSER || "/bin/echo",
          GH_PROMPT_DISABLED: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const session: AuthSession = {
      id: randomUUID(),
      process: child,
      output: "",
      startedAt: new Date().toISOString(),
      completed: false,
    };
    this.#session = session;

    const capture = (chunk: Buffer | string) => {
      const text = chunk.toString();
      session.output = `${session.output}${text}`.slice(-16_384);
      const match = session.output.match(DEVICE_CODE_RE);
      if (match?.[1] && !session.userCode) {
        session.userCode = match[1].toUpperCase();
        child.stdin.write("\n");
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("exit", (code) => {
      session.completed = true;
      session.exitCode = code;
    });
    child.once("error", (error) => {
      session.output = `${session.output}\n${error.message}`.slice(-16_384);
      session.completed = true;
      session.exitCode = null;
    });

    const deadline = Date.now() + 12_000;
    while (!session.userCode && !session.completed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!session.userCode) {
      if (!session.completed) child.kill("SIGTERM");
      throw new Error(
        `GitHub CLI did not produce a browser authorization code. Output: ${session.output.trim() || "(empty)"}`,
      );
    }

    return {
      state: "PENDING",
      authorizationId: session.id,
      verificationUri: DEVICE_URL,
      userCode: session.userCode,
      startedAt: session.startedAt,
    };
  }

  async status(input: { authorizationId?: string } = {}): Promise<Record<string, unknown>> {
    const login = await this.#currentLogin();
    if (login) {
      const matchesExpected = this.#expectedAuditorLogin
        ? login.toLowerCase() === this.#expectedAuditorLogin
        : undefined;
      return {
        state: matchesExpected === false ? "WRONG_ACCOUNT" : "AUTHENTICATED",
        account: login,
        expectedAccount: this.#expectedAuditorLogin,
        matchesExpected,
      };
    }

    const session = this.#session;
    if (!session || (input.authorizationId && input.authorizationId !== session.id)) {
      return { state: "NOT_AUTHENTICATED" };
    }
    return {
      state: session.completed ? "FAILED" : "PENDING",
      authorizationId: session.id,
      verificationUri: DEVICE_URL,
      userCode: session.userCode,
      startedAt: session.startedAt,
      exitCode: session.exitCode,
      diagnostic: session.completed ? session.output.trim().slice(-2_000) : undefined,
    };
  }

  async cancel(input: { authorizationId?: string } = {}): Promise<Record<string, unknown>> {
    const session = this.#session;
    if (!session || (input.authorizationId && input.authorizationId !== session.id)) {
      return { cancelled: false, reason: "No matching active authorization" };
    }
    if (!session.completed) session.process.kill("SIGTERM");
    session.completed = true;
    return { cancelled: true, authorizationId: session.id };
  }
}
