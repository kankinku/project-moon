# Project Moon

> A full-access remote development MCP runtime for trusted AI clients.

Project Moon turns a Linux host into a development environment that ChatGPT or another MCP client can operate directly. Instead of copying commands, logs, patches, and test results back and forth, the client can run commands, control long-running processes, edit and transfer files, work with Git, and execute a reproducible code-review workflow on the host itself.

Project Moon currently exposes **26 MCP tools** across three areas:

| Area | Tools | Purpose |
|---|---:|---|
| Execution & processes | 6 | Shells, scripts, long-running jobs, stdin, polling, termination |
| Filesystem | 14 | Read, write, patch, transfer, hash, copy, move, permissions, deletion |
| Review harness | 6 | Pinned Git review context, artifacts, worktrees, QA evidence, review state |

The code-review workflow is **model-independent**. The AI client performs reasoning; Project Moon owns the reproducible Git state, isolated worktree, persisted review artifacts, QA evidence, and staleness checks.

```text
                         MCP over HTTPS
┌───────────────────┐  ───────────────▶  ┌─────────────────────────────┐
│ ChatGPT / MCP     │                    │ Project Moon                │
│ client            │  ◀───────────────  │                             │
└───────────────────┘   tool results     │  Execution / Processes      │
                                         │  Filesystem                 │
                                         │  Review Harness             │
                                         └──────────────┬──────────────┘
                                                        │ full host access
                                                        ▼
                                         ┌─────────────────────────────┐
                                         │ Linux VPS / EC2 / server    │
                                         │ Git · Node · services · etc │
                                         └─────────────────────────────┘
```

> [!CAUTION]
> Project Moon is intentionally **not a sandbox**. It has no command allowlist, path restriction, per-command approval gate, or privilege reduction layer. If it runs as `root`, an authenticated client effectively has root-level host control. Use it only on systems you intend the connected client to administer, require strong authentication, and expose it through HTTPS.

## Why Project Moon?

Most AI coding workflows still have a boundary between reasoning and execution: the model proposes a command, a person runs it, the output is pasted back, and the cycle repeats. Project Moon removes that boundary for trusted environments while preserving explicit machine-readable tool contracts.

It is designed for workflows such as:

- inspecting a remote machine and diagnosing service failures;
- cloning, modifying, building, and testing repositories;
- running interactive or long-lived commands and polling their output later;
- transferring files without giving the client a separate SSH/SFTP integration;
- applying Git patches and managing repository state;
- reviewing a change against its intended design and project-specific criteria;
- isolating review/fix work in a Git worktree and retaining QA evidence;
- detecting when a previously reviewed branch has moved and the review is stale.

Project Moon is best suited to a **trusted development or operations host**. It is not intended to be a multi-tenant execution sandbox or an untrusted public code runner.

## Quick start

### Requirements

- Node.js 22 or later and npm
- Linux recommended; the production examples target systemd and Nginx
- Git
- OpenSSL for generating authentication secrets
- Python 3 only if you want to execute Python through `run_script`
- A stable HTTPS endpoint when connecting from a remote MCP client over the public internet

### Run locally

```bash
git clone https://github.com/kankinku/project-moon.git
cd project-moon
npm install
npm run build

export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
export MCP_DEFAULT_CWD=/root
npm start
```

The default endpoints are:

- MCP: `http://127.0.0.1:3000/mcp`
- health: `http://127.0.0.1:3000/health`

For a public deployment, normally place Project Moon behind HTTPS and configure either built-in OAuth 2.1 or a strong static Bearer token. Production examples are included under [`deploy/`](deploy/).

## Core capabilities

### 1. Execution and process control

| Tool | Purpose |
|---|---|
| `exec_command` | Run shell commands, builds, tests, package managers, Git, service commands, and log inspection |
| `run_script` | Run a complete Bash, sh, Node.js, Python, or custom-interpreter script |
| `write_stdin` | Send input to a managed long-running process and retrieve new output |
| `read_process` | Poll retained process output with a cursor and inspect completion state |
| `terminate_process` | Send `SIGINT`, `SIGTERM`, or `SIGKILL` to a managed process group |
| `list_processes` | List running and recently completed process sessions |

A command may finish inside the initial tool call or return a process `sessionId`. Later MCP requests can use that ID with `read_process`, `write_stdin`, or `terminate_process`. Managed process state is kept in service memory and is lost when the Project Moon service restarts.

### 2. Filesystem operations

Project Moon can operate on relative paths, absolute paths, and `~/...` paths. Relative paths resolve from `MCP_DEFAULT_CWD`.

Available tools:

- inspection: `list_directory`, `stat_path`, `read_file`, `hash_file`;
- editing: `write_file`, `replace_in_file`, `apply_patch`, `chmod_path`;
- transfer: `upload_file`, `download_file`;
- structure: `make_directory`, `copy_path`, `move_path`, `remove_path`.

`remove_path` permanently deletes targets; there is no trash layer. `apply_patch` uses the host's `git apply --unsafe-paths`.

#### File reading and transfer rules

- `offset`, `bytesRead`, and `nextOffset` are byte offsets/counts.
- UTF-8 reads never split a multibyte character. `bytesRead` may exceed the requested `maxBytes` by up to 3 bytes when required to return one complete character, while still staying under `MCP_MAX_FILE_CHUNK_BYTES`.
- Invalid UTF-8 is rejected. Use `encoding="base64"` for binary content.
- Base64 writes/uploads are strictly validated before modifying a file.
- `write_file.fileMode` applies to new files and to overwrite/append operations.
- `copy_path` reports a conflict when the destination exists and `force=false`.

### 3. Provider-independent code-review harness

The review harness adapts the core workflow ideas of the MAFIA Code-Review Harness into Project Moon-native MCP tools. It does **not** require Claude Code or another specific model/provider at runtime.

The central principle is simple: **reasoning can change, but the evidence being reviewed should not silently change underneath it.** A review run therefore pins the base, head, and merge-base commits and persists its state under `.moon/reviews/`.

```text
clean Git tree
    │
    ▼
CONTEXT_READY
    │ design intent
    ▼
INTENT_READY
    │ criteria
    ▼
CRITERIA_READY
    │ PR body
    ▼
REVIEW_READY
    │ findings
    ▼
REVIEWED
    │ decisions / accepted fixes
    ▼
FIXING
    │ QA
    ├──────────────▶ QA_FAILED
    ▼
QA
    │ final report
    ▼
PASSED

If the reviewed branch advances after the run was pinned:
PASSED/any state ──▶ effective state: STALE
```

#### Review tools

| Tool | Purpose |
|---|---|
| `review_start` | Require a clean tree, resolve base/head/merge-base SHAs, snapshot changed files/diff stats, create the review manifest |
| `review_context` | Return bounded stage-specific context for `intent`, `criteria`, `review`, or `fix` reasoning |
| `review_record` | Persist design intent, criteria, PR body, findings, decisions, and final report while enforcing dependencies |
| `review_worktree` | Create, inspect, or remove an isolated detached/writable Git worktree pinned to the reviewed commit |
| `review_qa` | Run sequential QA commands and persist stdout/stderr, exit status, duration, and pass/fail evidence |
| `review_status` | Report pinned/current SHA state, staleness, worktree state, unresolved P1 status, QA state, and `readyToPush` |

#### Typical review lifecycle

A client can drive the workflow in this order:

```text
1. review_start
2. review_context(stage="intent")
3. review_record(kind="design_intent")
4. review_context(stage="criteria")
5. review_record(kind="criteria")
6. review_record(kind="pr_body")
7. review_context(stage="review")
8. review_record(kind="review", p1Findings=...)
9. review_record(kind="decisions", unresolvedP1=...)
10. review_worktree(action="create", writable=true)   # optional fix isolation
11. review_context(stage="fix")                       # when fixes are needed
12. review_qa
13. review_record(kind="final_report")
14. review_status
```

Important invariants:

- `review_start` refuses a dirty working tree so the pinned commit fully represents the code under review.
- Changing an upstream review artifact invalidates dependent downstream artifacts and QA evidence. For example, revising criteria invalidates the PR body, findings, decisions, final report, and previous QA result.
- A final report requires a passing QA run and `unresolvedP1 == 0`.
- If the reviewed branch moves away from its pinned `headSha`, `review_status` reports `stale=true` and `effectiveState="STALE"`.
- A writable review worktree that diverges from the pinned commit is considered pending fix work, not proof that the new code has been reviewed.
- `readyToPush` is currently an **advisory review gate**. It does not intercept or prohibit an independent raw `git push` executed through `exec_command`.

Project-specific review conventions and architecture decisions can be stored in [`docs/code-convention.yaml`](docs/code-convention.yaml) and [`docs/adr.yaml`](docs/adr.yaml). The harness only includes those policy documents in the stage where they are relevant.

See [`harnesses/code-review/README.md`](harnesses/code-review/README.md) for the prompt contracts used by the workflow.

## How MCP requests are handled

`/mcp` is a stateless Streamable HTTP JSON endpoint. Every HTTP request is handled independently.

```text
client request
    │
    ▼
authentication / host validation
    │
    ▼
new stateless MCP transport
    │
    ▼
tool execution on host
    │
    ▼
JSON result + X-Request-Id
```

Key transport semantics:

- Each `POST /mcp` request gets a new MCP transport. Project Moon does not issue or require an `Mcp-Session-Id`.
- A stale `Mcp-Session-Id` header from an older client is ignored.
- Authenticated `GET /mcp` and `DELETE /mcp` requests normally return `405 Method Not Allowed`; no separate server-push SSE session is maintained.
- MCP transport state and command process `sessionId` values are unrelated.
- Process sessions survive across MCP HTTP requests only because Project Moon retains them in its own service memory.

## Authentication and security model

Project Moon supports two built-in authentication paths:

1. a static Bearer token;
2. a built-in OAuth 2.1 Authorization Server with DCR and PKCE.

### Static Bearer token

When `MCP_AUTH_TOKEN` is set, MCP calls require:

```http
Authorization: Bearer <MCP_AUTH_TOKEN>
```

Generate a high-entropy value, for example:

```bash
openssl rand -hex 32
```

### Built-in OAuth 2.1

Example environment values:

```dotenv
MCP_OAUTH_ENABLED=true
MCP_OAUTH_APPROVAL_KEY=<separate-value-generated-with-openssl-rand-hex-32>
MCP_PUBLIC_URL=https://mcp.example.com
MCP_OAUTH_ISSUER=https://mcp.example.com
MCP_OAUTH_RESOURCE=https://mcp.example.com/mcp
MCP_OAUTH_STATE_FILE=/var/lib/project-moon/oauth-state.json
```

The built-in authorization server provides:

- RFC 9728 Protected Resource Metadata;
- RFC 8414 Authorization Server Metadata;
- Dynamic Client Registration (DCR);
- Authorization Code + PKCE (`S256`);
- resource audience validation;
- access tokens;
- replay-detecting refresh-token rotation;
- grant-level token revocation.

OAuth uses a single `mcp:tools` scope. The approval page requires `MCP_OAUTH_APPROVAL_KEY`. For an OAuth-only deployment, leave `MCP_AUTH_TOKEN` empty so there is no permanent static-Bearer bypass. When no dedicated approval key is configured, `MCP_AUTH_TOKEN` is used for backward compatibility, but separating the credentials is safer.

Registered clients, client secrets, and token hashes are stored in `MCP_OAUTH_STATE_FILE` with file mode `600`.

OAuth routes:

| Path | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` | RFC 9728 resource metadata |
| `/.well-known/oauth-protected-resource/mcp` | Resource metadata for `/mcp` |
| `/.well-known/oauth-authorization-server` | RFC 8414 authorization-server metadata |
| `/register` | Dynamic Client Registration |
| `/authorize` | User approval and authorization-code issuance |
| `/token` | Authorization-code / refresh-token exchange |
| `/revoke` | Token revocation |

### External authentication

If authentication is enforced by an upstream OAuth gateway, private network, or another trusted proxy, built-in checks can be disabled:

```dotenv
MCP_AUTH_TOKEN=
MCP_OAUTH_ENABLED=false
MCP_ALLOW_NO_AUTH=true
```

`MCP_ALLOW_NO_AUTH=true` does not make the service anonymous while a static token remains configured or built-in OAuth remains enabled.

When delegating authentication upstream, bind Project Moon to `127.0.0.1` and prevent direct public access to the Node.js port. An unauthenticated public Project Moon endpoint exposes the host's execution privileges to anyone who can reach it.

### MCP safety metadata

Every tool publishes all four MCP tool-safety hints. These values are advisory metadata for clients, not an authorization boundary.

| Behavior | Tools | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|---|---|---:|---:|---:|---:|
| Read-only, closed world | `list_directory`, `stat_path`, `read_file`, `download_file`, `hash_file`, `read_process`, `list_processes`, `review_context`, `review_status` | `true` | `false` | `true` | `false` |
| Additive and idempotent | `make_directory` | `false` | `false` | `true` | `false` |
| Additive and non-idempotent | `review_start` | `false` | `false` | `false` | `false` |
| Destructive and idempotent | `upload_file`, `copy_path`, `move_path`, `remove_path`, `chmod_path` | `false` | `true` | `true` | `false` |
| Destructive and non-idempotent, closed world | `write_file`, `replace_in_file`, `apply_patch`, `terminate_process`, `review_record`, `review_worktree` | `false` | `true` | `false` | `false` |
| Destructive and non-idempotent, open world | `exec_command`, `run_script`, `write_stdin`, `review_qa` | `false` | `true` | `false` | `true` |

When built-in OAuth is enabled, tools also advertise the `oauth2` security scheme with the `mcp:tools` scope through `_meta.securitySchemes`. Static Bearer and `MCP_ALLOW_NO_AUTH` deployments intentionally do not claim to be OAuth or `noauth` at the per-tool metadata layer because the actual deployment boundary may be handled elsewhere.

## Local development

```bash
export MCP_HOST=127.0.0.1
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
npm run dev
```

Useful project commands:

```bash
npm run typecheck
npm test
npm run build
```

## VPS / EC2 deployment

The repository includes systemd, environment-file, and Nginx examples under [`deploy/`](deploy/). The following example installs Project Moon at `/opt/project-moon` on an Ubuntu-based host:

```bash
sudo mkdir -p /opt/project-moon
sudo cp -a package.json package-lock.json tsconfig.json src deploy /opt/project-moon/
cd /opt/project-moon
sudo npm ci
sudo npm run build
sudo npm prune --omit=dev

sudo install -d -m 0700 /var/lib/project-moon

sudo cp deploy/project-moon.env.example /etc/project-moon.env
sudo chmod 600 /etc/project-moon.env
sudo editor /etc/project-moon.env

sudo cp deploy/project-moon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now project-moon
sudo systemctl status project-moon
```

If `/usr/bin/node` is not the real Node.js path, update `ExecStart` in the unit file (`which node` can locate it).

For a public deployment:

- terminate TLS at Nginx or another trusted reverse proxy;
- bind Project Moon itself to `127.0.0.1`;
- expose only the HTTPS proxy ports externally;
- use a proxy read timeout long enough for long-running tool calls;
- persist OAuth state outside the application checkout;
- keep secrets outside Git.

Set `MCP_TRUST_PROXY_HOPS=1` only when exactly one trusted reverse proxy is in front of Project Moon. Incorrectly trusting forwarded IP headers can undermine IP-based OAuth rate limiting.

A minimal OAuth-oriented production configuration looks like:

```dotenv
MCP_HOST=127.0.0.1
MCP_PUBLIC_URL=https://mcp.example.com
MCP_ALLOWED_HOSTS=mcp.example.com,127.0.0.1,localhost
MCP_TRUST_PROXY_HOPS=1
MCP_AUTH_TOKEN=
MCP_OAUTH_ENABLED=true
MCP_OAUTH_APPROVAL_KEY=<value-generated-with-openssl-rand-hex-32>
MCP_OAUTH_ISSUER=https://mcp.example.com
MCP_OAUTH_RESOURCE=https://mcp.example.com/mcp
MCP_OAUTH_STATE_FILE=/var/lib/project-moon/oauth-state.json
```

## Connecting ChatGPT

Assume the deployed MCP URL is:

```text
https://mcp.example.com/mcp
```

The exact ChatGPT UI can vary by account/workspace configuration, but the connection needs the same underlying information: the MCP URL and an authentication method. When using Project Moon's built-in OAuth server, use its Dynamic Client Registration flow and the `mcp:tools` scope. When the Project Moon approval page appears, authorize the connection with `MCP_OAUTH_APPROVAL_KEY`.

Project Moon provides DCR and OAuth Authorization Code + PKCE (`S256`); it does not implement CIMD or OIDC.

Because Project Moon exposes write, delete, and command-execution tools, the connected ChatGPT workspace or client must permit the corresponding MCP capabilities. Client/workspace policy can restrict capabilities even when the server exposes them.

Relevant OpenAI documentation:

- [ChatGPT Plugins Quickstart](https://developers.openai.com/plugins/quickstart)
- [Developer mode and full MCP connectors in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta)
- [MCP server authentication](https://developers.openai.com/plugins/build/auth)
- [MCP and Connectors in the Responses API](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)

## Operations and troubleshooting

### Health and logs

```bash
# Local service behind the reverse proxy
curl http://127.0.0.1:3000/health

# Public endpoint
curl https://mcp.example.com/health

# systemd status / logs
sudo systemctl status project-moon
sudo journalctl -u project-moon -f

# Restart after configuration or code changes
sudo systemctl restart project-moon
```

Example health response:

```json
{
  "status": "ok",
  "service": "project-moon",
  "version": "0.1.0",
  "transportMode": "stateless-json",
  "activeMcpSessions": 0,
  "activeMcpRequests": 0,
  "managedProcesses": 0,
  "unrestrictedHostAccess": true,
  "oauthEnabled": true
}
```

Notes:

- `activeMcpSessions` is always `0` in stateless mode.
- `activeMcpRequests` is the number of MCP HTTP requests currently being processed.
- `managedProcesses` includes running and recently completed process records. Inspect each record's `running` field for actual execution state.
- Completed process records are removed after `MCP_PROCESS_RETENTION_MS`.
- Every MCP response includes `X-Request-Id` for tracing.
- Structured `event="mcp_request"` logs include RPC method, tool name, HTTP status, outcome, and duration without logging authentication tokens or tool arguments.

Filter recent MCP request logs:

```bash
sudo journalctl -u project-moon -o cat | grep '"event":"mcp_request"'
```

### Common failures

| Symptom | Check |
|---|---|
| OAuth configuration cannot be fetched | `MCP_OAUTH_ENABLED`, public URL, `/.well-known/` proxy routing |
| `401 Unauthorized` | static Bearer token or OAuth access token |
| `403 Host header is not allowed` | `MCP_ALLOWED_HOSTS` |
| command returned `sessionId` | poll with `read_process` or interact with `write_stdin` |
| authenticated `GET /mcp` returns `405` | expected for the stateless POST-only MCP transport |
| managed process disappeared after restart | process state is intentionally in-memory |
| review reports `STALE` | the reviewed head branch moved after `review_start`; start a new review run |
| `final_report` is rejected | resolve all P1 findings and produce fresh passing QA evidence |

## Verification

The normal repository verification sequence is:

```bash
npm run typecheck
npm test
npm run build
```

The test suite uses a real Streamable HTTP MCP client and covers authentication, stateless request handling, process lifecycle, file operations, UTF-8/base64 boundaries, patch application, OAuth, all 26 tool contracts, and the review-harness lifecycle.

The review E2E path specifically verifies:

- dirty-tree rejection at review start;
- pinned base/head/merge-base context;
- artifact dependency invalidation;
- isolated Git worktree creation/removal;
- unresolved-P1 blocking;
- QA invalidation and required rerun after decisions change;
- successful final gate;
- stale detection after the reviewed branch advances.

### External E2E verification

From a separate source checkout with development dependencies installed, all 26 tools can be exercised against a running HTTPS endpoint:

```bash
MCP_E2E_URL='https://mcp.example.com/mcp' \
MCP_E2E_TOKEN='<bearer-token>' \
MCP_E2E_ROOT='/tmp/project-moon-tools-e2e-manual' \
npx vitest run test/all-tools.integration.test.ts
```

This test executes real commands and creates/modifies/deletes files on the target host. `MCP_E2E_ROOT` must match `/tmp/project-moon-tools-e2e-*`; do not point it at production data. Run external E2E tests from a separate checkout rather than changing the production installation's dependency layout.

## Configuration reference

| Variable | Default | Description |
|---|---:|---|
| `MCP_HOST` | `0.0.0.0` | HTTP bind address |
| `MCP_PORT` | `3000` | HTTP port |
| `MCP_ENDPOINT` | `/mcp` | Streamable HTTP MCP path |
| `MCP_PUBLIC_URL` | none | External HTTPS base URL excluding `/mcp` |
| `MCP_ALLOWED_HOSTS` | none | Comma-separated allowed Host-header hostnames |
| `MCP_TRUST_PROXY_HOPS` | `0` | Number of trusted reverse-proxy hops |
| `MCP_AUTH_TOKEN` | none | Optional static Bearer token |
| `MCP_ALLOW_NO_AUTH` | `false` | Allow startup with no built-in authentication |
| `MCP_OAUTH_ENABLED` | `false` | Enable built-in OAuth 2.1/DCR |
| `MCP_OAUTH_APPROVAL_KEY` | `MCP_AUTH_TOKEN` | Key used on the OAuth connection approval page |
| `MCP_OAUTH_ISSUER` | `MCP_PUBLIC_URL` | OAuth issuer URL |
| `MCP_OAUTH_RESOURCE` | `<MCP_PUBLIC_URL><MCP_ENDPOINT>` | MCP resource audience |
| `MCP_OAUTH_STATE_FILE` | inside working directory | Persistent registered-client/token-hash state |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` | Access-token lifetime |
| `MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh-token lifetime |
| `MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS` | `300` | One-time authorization-code lifetime |
| `MCP_DEFAULT_CWD` | server startup directory | Base directory for relative filesystem/command paths |
| `MCP_DEFAULT_SHELL` | `$SHELL` or `/bin/bash` | Default shell for `exec_command` |
| `MCP_MAX_REQUEST_BODY` | `8mb` | HTTP request-body limit |
| `MCP_MAX_OUTPUT_BYTES` | `1048576` | Maximum output returned in one tool response |
| `MCP_MAX_RETAINED_PROCESS_OUTPUT_BYTES` | `4194304` | Retained output per managed process |
| `MCP_PROCESS_RETENTION_MS` | `3600000` | Completed-process retention period |
| `MCP_MAX_PROCESSES` | `128` | Maximum retained process records |
| `MCP_MAX_FILE_CHUNK_BYTES` | `1048576` | Maximum file read/transfer chunk |
| `MCP_MAX_EDIT_FILE_BYTES` | `67108864` | Maximum file size for text replacement |

See [`.env.example`](.env.example) and [`deploy/project-moon.env.example`](deploy/project-moon.env.example) for deployable examples.

## Repository layout

| Path | Purpose |
|---|---|
| `src/http-server.ts` | Stateless Streamable HTTP transport, auth routing, and health endpoint |
| `src/mcp-server.ts` | MCP server metadata and tool registration |
| `src/exec-tools.ts` | Commands, scripts, and managed-process tools |
| `src/file-service.ts` | Host filesystem implementation |
| `src/file-tools.ts` | Filesystem MCP schemas and registration |
| `src/oauth.ts` | DCR, PKCE, token issuance/refresh/revocation, approval UI |
| `src/review/` | Provider-independent Git review state machine, tools, QA, and worktrees |
| `docs/code-convention.yaml` | Project-specific review conventions |
| `docs/adr.yaml` | Architecture decisions consumed by review criteria generation |
| `harnesses/code-review/` | Review workflow documentation and prompt contracts |
| `vendor/mafia-codereview-harness/` | Upstream review-harness provenance |
| `deploy/` | systemd, environment-file, and Nginx examples |
| `test/all-tools.integration.test.ts` | Real MCP integration coverage for all 26 tools |
| `test/` | Configuration, process, file, MCP, auth, OAuth, and integration tests |

## Upstream and attribution

Project Moon is derived from the MIT-licensed [`kstost/cokacremote`](https://github.com/kstost/cokacremote) project. The original copyright and license notice are preserved in [`LICENSE`](LICENSE).

The code-review workflow is adapted from the MIT-licensed [`vibemafiaclub/mafia-codereview-harness`](https://github.com/vibemafiaclub/mafia-codereview-harness). Project Moon reimplements the workflow concepts as provider-independent MCP tools rather than depending on the original Claude Code plugin at runtime. Detailed provenance is recorded in [`vendor/mafia-codereview-harness/SOURCE.md`](vendor/mafia-codereview-harness/SOURCE.md).

## License

[MIT License](LICENSE)

## Disclaimer

THIS SOFTWARE IS PROVIDED “AS IS,” WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.

IN NO EVENT SHALL THE AUTHOR, COPYRIGHT HOLDERS, OR CONTRIBUTORS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF THE SOFTWARE.

This includes, but is not limited to, data loss or corruption, system damage or malfunction, security breaches or vulnerabilities, financial loss, and direct or indirect consequential damages. The user assumes full responsibility for the consequences of operating a full-access remote development service.
