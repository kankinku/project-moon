import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitHubCliAuthService } from "../src/github/github-cli-auth-service.js";

const linuxIt = process.platform === "win32" ? it.skip : it;

describe("GitHubCliAuthService", () => {
  const tempDirs: string[] = [];
  const previousFakeState = process.env.FAKE_GH_STATE;

  afterEach(async () => {
    if (previousFakeState === undefined) delete process.env.FAKE_GH_STATE;
    else process.env.FAKE_GH_STATE = previousFakeState;
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function fakeGh(): Promise<{ binary: string; state: string }> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "moon-gh-auth-"));
    tempDirs.push(directory);
    const state = path.join(directory, "login.txt");
    const binary = path.join(directory, "gh");
    await writeFile(
      binary,
      `#!/usr/bin/env bash
set -eu
state="${state}"
if [[ "\${1:-}" == "api" && "\${2:-}" == "user" ]]; then
  if [[ -s "$state" ]]; then
    cat "$state"
    exit 0
  fi
  exit 1
fi
if [[ "\${1:-}" == "auth" && "\${2:-}" == "login" ]]; then
  echo "! First copy your one-time code: TEST-CODE" >&2
  read -r _ || true
  printf '%s\\n' "moon-auditor" > "$state"
  sleep 0.2
  exit 0
fi
exit 2
`,
      "utf8",
    );
    await chmod(binary, 0o755);
    return { binary, state };
  }

  linuxIt("returns a browser URL/code and resolves the authenticated auditor account", async () => {
    const fake = await fakeGh();
    process.env.FAKE_GH_STATE = fake.state;
    const service = new GitHubCliAuthService({
      ghBinary: fake.binary,
      expectedAuditorLogin: "moon-auditor",
    });

    const started = await service.start();
    expect(started).toMatchObject({
      state: "PENDING",
      verificationUri: "https://github.com/login/device",
      userCode: "TEST-CODE",
    });
    expect(typeof started.authorizationId).toBe("string");

    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect(
      service.status({ authorizationId: String(started.authorizationId) }),
    ).resolves.toMatchObject({
      state: "AUTHENTICATED",
      account: "moon-auditor",
      expectedAccount: "moon-auditor",
      matchesExpected: true,
    });
  });

  linuxIt("rejects an already authenticated account that is not the configured auditor", async () => {
    const fake = await fakeGh();
    await writeFile(fake.state, "main-developer\n", "utf8");
    const service = new GitHubCliAuthService({
      ghBinary: fake.binary,
      expectedAuditorLogin: "moon-auditor",
    });

    await expect(service.start()).rejects.toThrow(/does not match expected merge auditor/);
  });
});
