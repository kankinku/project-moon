# Independent Merge Audit Architecture

## Goal

Project Moon exposes **one public MCP connection** while keeping development authority and final merge authority separated internally.

The public client connects only to the normal Moon endpoint. Merge workflow calls are routed over the private Docker network to an isolated Merge Auditor runtime that uses a different GitHub account.

```text
ChatGPT / MCP client
  |
  | OAuth 2.1
  v
Project Moon / Developer Runtime
  | 32 development tools
  | + 6 merge_audit_* gateway tools when configured
  |
  | private Docker network
  | internal service Bearer only
  v
Merge Auditor Runtime
  | read-only /audit/shared
  | independent Docker state volume
  | secondary GitHub CLI account
  |
  +-> SHA-bound audit
  +-> GitHub APPROVE / REQUEST_CHANGES
  +-> mechanically gated merge
```

This preserves a simple single-app UX without giving the developer runtime the auditor's GitHub credentials.

## Trust boundaries

### Developer runtime

`MCP_RUNTIME_ROLE=developer`

The normal Moon runtime owns implementation:

- command/process tools
- filesystem tools
- task harness
- internal review harness
- Git development workflow

Without an initialized auditor it exposes the existing 32-tool surface.

When the merge-auditor proxy is enabled, it additionally exposes:

- `merge_audit_start`
- `merge_audit_context`
- `merge_audit_decide`
- `merge_audit_status`
- `merge_audit_publish`
- `merge_audit_merge`

These six tools do not execute the audit locally. They are bounded proxies to the private Merge Auditor runtime.

The developer runtime receives only:

- the internal auditor MCP URL
- an internal service Bearer credential

It does **not** receive the secondary GitHub account credential.

### Merge Auditor runtime

`MCP_RUNTIME_ROLE=merge-auditor`

The private auditor runtime exposes only:

- `merge_auditor_auth_start`
- `merge_auditor_auth_status`
- `merge_auditor_auth_cancel`
- `merge_audit_start`
- `merge_audit_context`
- `merge_audit_decide`
- `merge_audit_status`
- `merge_audit_publish`
- `merge_audit_merge`

It does not expose `exec_command`, filesystem write tools, implementation task tools, repair worktrees, or arbitrary GitHub commands.

The host `shared/` workspace is mounted read-only in the auditor as:

```text
developer: /shared/<project>
auditor:   /audit/shared/<project>
```

The public gateway accepts only developer paths under `/shared` and performs this mapping before forwarding the audit request.

## Network model

There is only one public ingress:

```text
https://project-moon.<tailnet>.ts.net/mcp
  -> Tailscale Funnel HTTPS 443
  -> 127.0.0.1:2999
  -> Project Moon Developer Runtime
```

The auditor is not a second public MCP application. The canonical path is:

```text
Developer Runtime
  -> http://merge-auditor:2999/mcp
  -> private Docker network
  -> Merge Auditor Runtime
```

Host loopback port `3999` may remain available for local diagnostics, but no Tailscale Funnel listener is required for the auditor.

## Authentication model

Three authentication domains are deliberately separate.

### ChatGPT -> Project Moon

The existing public Moon endpoint uses its normal OAuth 2.1 + DCR + PKCE flow. No second ChatGPT connector or second OAuth registration is required.

### Project Moon -> Merge Auditor

The private RPC path uses a dedicated service Bearer secret. On Windows it is stored outside the shared workspace:

```text
%LOCALAPPDATA%\ProjectMoon\merge-auditor.env
```

The secret is not committed to Git and is not printed by startup helpers.

### Merge Auditor -> GitHub

The secondary GitHub account is authenticated through the official GitHub CLI. Its configuration is stored only in:

```text
/var/lib/project-moon/gh
```

inside the independent `project-moon-auditor-state` Docker volume.

Container restarts and image rebuilds preserve this login while the named volume remains intact. The developer runtime never mounts or reads that credential store.

## Bootstrap

`Initialize-MergeAuditor.ps1` configures the expected secondary GitHub login, creates/migrates the internal service secret, and imports the secondary GitHub CLI credential into the auditor volume. `Start-PublicMcp.ps1` enables the proxy only at runtime when both the expected auditor login and the host-only secret are actually present, so developer-only manual Compose starts remain compatible.

Authentication bootstrap tools remain internal to the auditor runtime. They are not published through the normal Moon tool surface.

After initialization, `Start-PublicMcp.ps1` starts the Developer Runtime and the Merge Auditor together, verifies the secondary GitHub account, and exposes only the normal HTTPS 443 Moon endpoint.

`Start-MergeAuditorMcp.ps1` remains available as an operator recovery/diagnostic helper for the private auditor container. It does not create a public Funnel.

## SHA-bound audit

`merge_audit_start` pins:

- base SHA
- head SHA
- merge-base SHA
- changed files
- diff summary
- original request / optional internal-review evidence

`MERGE_APPROVED` is valid only for the pinned head SHA.

If the reviewed branch moves, the audit becomes `STALE`. Before publishing a GitHub review and before executing a merge, Moon re-checks the live GitHub PR head.

```text
local reviewed head moved -> reject
GitHub PR head moved       -> reject
```

## Independent review publication

Before `merge_audit_publish`, Moon verifies:

1. the local audit is not stale;
2. the audit has a recorded decision and rationale;
3. the current GitHub CLI account matches the configured auditor account;
4. the auditor account is different from the PR author;
5. the PR is open and not draft;
6. the live PR head equals the audited SHA;
7. a `MERGE_APPROVED` decision has zero unresolved P1 findings.

The decision maps to GitHub as:

```text
MERGE_APPROVED   -> APPROVE
CHANGES_REQUIRED -> REQUEST_CHANGES
BLOCKED          -> REQUEST_CHANGES
```

The review body records the auditor account, audited SHA, run ID, unresolved P1 count, rationale, and a warning that a new head SHA requires a new audit.

## Mechanical merge gate

`merge_audit_merge` performs no code-quality reasoning. It is a mechanical executor and runs only after the independent audit already reached `MERGE_APPROVED`.

Before invoking GitHub merge, it requires all of the following:

1. the audit is not stale;
2. `approvalSha` equals the current audited head;
3. the live PR head equals the audited 40-character SHA;
4. the authenticated GitHub account exactly matches the configured auditor account;
5. the PR author is different from the auditor;
6. the PR is open and not draft;
7. GitHub reports `reviewDecision=APPROVED`;
8. `latestReviews` contains an `APPROVED` review from the authenticated auditor account itself;
9. GitHub reports `mergeStateStatus=CLEAN`;
10. CI/status-check evidence exists and every check is successful, neutral, or skipped.

Only then does the executor run the fixed command equivalent to:

```text
gh pr merge <PR> --repo <OWNER/NAME> --merge --match-head-commit <AUDITED_SHA>
```

No `--admin` bypass or arbitrary GitHub argument is exposed.

Afterward Moon re-reads the PR and requires GitHub to report:

- state `MERGED`
- `mergedBy` equal to the auditor account
- a merge commit SHA
- a merge timestamp

## Repository permissions and branch protection

The secondary auditor account requires enough repository permission for its review to count and for it to merge after branch requirements are satisfied. That GitHub permission is broader than the runtime operations Project Moon exposes, so the runtime is deliberately constrained.

Recommended `main` protection:

- require pull request before merging
- require at least one approving review
- dismiss stale approvals when new commits are pushed
- require Project Moon CI / `validate`
- require conversation resolution when appropriate
- block force pushes
- block branch deletion
- prevent administrator bypass when possible

With these rules, the intended path is:

```text
developer implementation
 -> developer push / PR
 -> CI validate
 -> isolated merge audit
 -> auditor APPROVE
 -> mechanical SHA/CI/review gate
 -> auditor merge
 -> protected main
```

## Security invariants

The durable invariants are:

- one public Moon MCP connection;
- no public auditor Funnel is required;
- developer and auditor GitHub identities remain different;
- auditor GitHub credentials exist only in the auditor state volume;
- source is read-only inside the auditor;
- public merge tools are allowlisted proxies, not arbitrary RPC forwarding;
- developer repository paths outside `/shared` are rejected by the proxy;
- approval and merge are bound to an exact SHA;
- the auditor's own GitHub approval is required before merge;
- failed or incomplete CI blocks merge;
- no admin bypass is used by the merge executor.
