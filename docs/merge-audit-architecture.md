# Independent Merge Audit Architecture

## Goal

Separate development-time implementation and internal audit from the final decision to merge into `main`.

Project Moon uses two independent runtime identities:

```text
Developer Moon container
GitHub main account
  -> implement
  -> validate
  -> internal audit
  -> commit / push
  -> pull request

        trust boundary

Merge Auditor container
GitHub secondary account
  -> browser authorization bootstrap
  -> inspect pinned diff
  -> independent decision
  -> APPROVE or REQUEST_CHANGES with rationale

        trust boundary

Merge gate / executor
  -> verify approval and current SHA
  -> merge
```

## Runtime separation

### Developer runtime

`MCP_RUNTIME_ROLE=developer`

The normal Moon runtime keeps the existing development tool surface:

- command/process tools
- filesystem tools
- task harness
- internal review harness

It does **not** expose auditor authentication or `merge_audit_*` final-approval tools.

### Merge Auditor runtime

`MCP_RUNTIME_ROLE=merge-auditor`

The independent runtime exposes only:

- `merge_auditor_auth_start`
- `merge_auditor_auth_status`
- `merge_auditor_auth_cancel`
- `merge_audit_start`
- `merge_audit_context`
- `merge_audit_decide`
- `merge_audit_status`
- `merge_audit_publish`

It does not expose `exec_command`, file-write tools, repair worktrees, task implementation tools, or push commands.

The audited Git repository is mounted read-only at `/audit/repo`. Audit execution state is written to a separate state volume rather than into the source repository.

## GitHub identity model

A dedicated secondary GitHub user account is used for merge auditing.

The developer computer and normal Moon container may remain authenticated as the main development account. The auditor container keeps its own GitHub CLI configuration under:

```text
/var/lib/project-moon/gh
```

This directory lives in the independent `project-moon-auditor-state` Docker volume, so the auditor login does not reuse the host computer's GitHub credential or the normal Moon credential.

No GitHub App, App private key, custom OAuth client, or Project Moon-managed refresh token is required. Project Moon delegates login and credential persistence to the official GitHub CLI.

## MCP-driven auditor login

The preferred bootstrap UX is controlled through the auditor MCP rather than asking the user to run `gh auth login` manually.

```text
Assistant
  -> merge_auditor_auth_start
Auditor container
  -> starts `gh auth login --web`
  -> returns GitHub verification URL + one-time code only
User
  -> opens the URL
  -> signs in as the secondary GitHub account
  -> enters/confirms the code
  -> authorizes GitHub CLI
Assistant
  -> merge_auditor_auth_status
  -> confirms the authenticated account
```

`merge_auditor_auth_start` keeps the GitHub CLI login process alive inside the auditor container while the user completes authorization. It never returns a GitHub access token, refresh token, password, or credential-file contents.

The GitHub CLI credential persists in the auditor state volume across container restarts and image rebuilds. Deleting that Docker volume intentionally removes the auditor login.

An operator may still use the equivalent manual fallback if MCP bootstrap is unavailable:

```bash
docker compose -f tunneling/docker-compose.local.yml --profile merge-auditor run --rm --entrypoint gh merge-auditor auth login
```

Set the expected secondary username in the local environment when known:

```text
MCP_GITHUB_AUDITOR_LOGIN=<secondary-account-login>
```

During authentication and before publishing any review, Moon checks the actual `gh` account against this value when configured. It also rejects an audit when the authenticated auditor is the pull request author.

## SHA-bound decision

`merge_audit_start` pins:

- base SHA
- head SHA
- merge-base SHA
- changed files
- diff summary

`MERGE_APPROVED` is valid only for the pinned head SHA.

If the local reviewed branch moves, the audit becomes `STALE`. Immediately before publishing a GitHub review, Moon also asks GitHub for the PR's current `headRefOid`. If that remote SHA differs from the audited SHA, publication is rejected as stale.

This gives two independent stale checks:

```text
local audited branch moved -> reject
GitHub PR head moved       -> reject
```

## Independent account checks

Before `merge_audit_publish`, Moon verifies:

1. `gh api user` resolves the currently authenticated GitHub account.
2. If `MCP_GITHUB_AUDITOR_LOGIN` is configured, the login exactly matches that account.
3. The authenticated auditor account is different from the PR author.
4. The PR is open.
5. The PR is not draft.
6. GitHub's current PR head SHA equals the audited SHA.
7. `MERGE_APPROVED` has no unresolved P1 finding.

Only then is a GitHub PR review submitted.

## Review mapping

```text
MERGE_APPROVED   -> GitHub APPROVE
CHANGES_REQUIRED -> GitHub REQUEST_CHANGES
BLOCKED          -> GitHub REQUEST_CHANGES
```

Every review body records:

- decision
- auditor account
- audited SHA
- unresolved P1 count
- audit run ID
- human-readable rationale
- warning that a new head SHA requires a new audit

The PR review itself becomes the durable external audit trail.

## Repository permissions

For a private repository under a personal GitHub account, the secondary auditor account may need collaborator write permission in order for its review to count toward protected-branch approval requirements. That GitHub permission is broader than the auditor should normally exercise.

Project Moon compensates operationally by constraining the auditor runtime:

- source repository bind mount is read-only
- development/exec/file-write tools are absent
- no push tool is exposed
- `merge_audit_publish` performs only fixed `gh api`, `gh pr view`, and `gh pr review` operations
- auditor login bootstrap exposes only URL/code/status/cancel operations

The secondary account credential should exist only in the auditor Docker volume.

## Branch protection / ruleset

Recommended `main` protection after the auditor account is connected and tested:

- require pull request before merging
- require at least one approving review
- dismiss stale approvals when new commits are pushed, or require approval of the latest push
- require Project Moon CI
- block force pushes

The approval is therefore supplied by the dedicated secondary account rather than the development account.

## Merge executor

The final merge executor remains a separate future step. It must not perform code-quality reasoning. It should only verify mechanical conditions such as:

1. PR head SHA equals the SHA that received the independent audit approval
2. required CI checks are successful
3. no blocking review remains
4. repository rules allow merge

Then, and only then, it may perform the merge.
