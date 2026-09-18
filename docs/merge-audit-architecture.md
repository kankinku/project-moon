# Independent Full Merge Audit Architecture

## Goal

Project Moon exposes one public MCP connection while keeping implementation authority and final merge authority separated internally. The Merge Auditor is a **final independent code reviewer and quality gate**, not merely a mechanical merge-safety checker.

The public client connects only to the normal Moon endpoint. The developer runtime proxies an allowlisted merge workflow over the private Docker network to an isolated Merge Auditor runtime using a different GitHub account.

```text
ChatGPT / MCP client
  |
  | OAuth 2.1
  v
Project Moon / Developer Runtime
  | implementation + task/review harness
  | + 6 merge_audit_* gateway tools
  |
  | private Docker network
  | internal service Bearer
  v
Merge Auditor Runtime
  | read-only /audit/shared
  | independent state volume
  | secondary GitHub CLI account
  |
  +-> repository/PR/base/head-pinned full review
  +-> structured P1-P4 findings + validation evidence
  +-> GitHub APPROVE / REQUEST_CHANGES
  +-> mechanical live GitHub merge gate
```

## Trust boundaries

### Developer runtime

The developer runtime owns implementation, filesystem/command execution, task validation, ordinary review, Git development, and repair work.

When the auditor proxy is configured it additionally exposes:

- `merge_audit_start`
- `merge_audit_context`
- `merge_audit_decide`
- `merge_audit_status`
- `merge_audit_publish`
- `merge_audit_merge`

These are bounded proxies. The developer runtime receives the private auditor MCP URL and internal service Bearer only; it never receives the secondary GitHub credential.

### Merge Auditor runtime

The private auditor exposes only its authentication bootstrap tools plus the six merge-audit tools. It does not expose arbitrary command execution, filesystem writes, repair worktrees, implementation tasks, or arbitrary GitHub commands.

The workspace mapping remains:

```text
developer: /shared/<project>
auditor:   /audit/shared/<project>   # read-only
```

Repository code is **not executed inside the credential-bearing auditor runtime**. Tests/builds belong to developer/CI environments; the auditor reviews their evidence and the final merge executor independently rechecks live GitHub CI.

## Authentication

Three domains remain separate:

1. ChatGPT -> Project Moon: public OAuth 2.1/DCR/PKCE.
2. Project Moon -> Merge Auditor: host-managed private service Bearer.
3. Merge Auditor -> GitHub: secondary GitHub CLI account stored only in the auditor state volume.

The developer runtime never mounts the auditor GitHub credential store.

## Immutable audit target

`merge_audit_start` pins all of the following:

- GitHub repository `owner/name`
- pull request number
- base branch and base SHA
- head branch and head SHA
- merge-base SHA
- changed files and diff summary
- original request / acceptance criteria
- optional internal-review evidence
- derived change risk and required validation profile

An audit becomes `STALE` when either the local base branch or local head branch moves.

Before publishing a review and before merging, Moon also re-checks GitHub and requires the live PR to match the audited repository/PR, base branch, **base SHA**, and head SHA.

```text
local base moved        -> reject
local head moved        -> reject
GitHub PR base moved    -> reject
GitHub PR head moved    -> reject
wrong repository / PR   -> reject
```

## Full independent review

`merge_audit_context` returns the pinned diff together with relevant project policy evidence and the risk-derived validation requirement. Repeated context calls may also use `includePaths` and `searchTerms` to read unchanged repository paths and discover callers/consumers/tests via bounded `git show`/literal `git grep` against the exact audited head SHA; this never exposes arbitrary auditor-container filesystem paths.

The auditor must independently review every category:

- requirements
- correctness
- code quality
- tests
- regression
- architecture
- API contracts
- security
- performance
- operations
- maintainability

Each category receives an evidence-backed verdict: `PASS`, `CONCERN`, or `NOT_APPLICABLE`. `NOT_APPLICABLE` still requires a concrete explanation.

Findings are structured as P1-P4 and record category, concrete evidence, optional file/line, recommendation, and whether the finding is resolved in the pinned SHA. P1 is merge-blocking.

Internal developer review is **evidence only** and is never interpreted as approval.

## Risk-based validation evidence

Risk is derived from the pinned request and changed paths using the repository's pinned Moon harness policy. The corresponding validation profile (for example `fast`, `normal`, or `release`) becomes part of the audit contract.

Validation evidence records:

- source
- validation profile
- exact validated head SHA
- pass/fail
- traceable reference
- summary of checks performed

The auditor does not execute untrusted repository code itself. `MERGE_APPROVED` requires passing evidence for the exact audited head SHA at the required profile or stronger. The later GitHub merge gate independently requires live CI/status checks to exist and be successful.

## Approval gate

`MERGE_APPROVED` is accepted only when all of these are true:

1. repository/PR/base/head target remains current;
2. every mandatory review category is present;
3. no category has `CONCERN`;
4. no unresolved P1 finding remains;
5. risk-required validation evidence passed for the exact head SHA;
6. an evidence-based rationale is recorded.

The manifest persists structured findings, coverage, validation evidence, risk, rationale, and approval SHA. Approval remains valid only for the pinned target. Full-review manifests use schema version 2; legacy schema version 1 audit runs are deliberately rejected and must be recreated because their earlier approvals did not satisfy the full-review contract.

## GitHub review publication

Before `merge_audit_publish`, Moon verifies:

1. the local audit is not stale;
2. the repository and PR match the target pinned at audit start;
3. the structured quality gate is satisfied for `MERGE_APPROVED`;
4. the authenticated GitHub account matches the configured auditor account;
5. the auditor differs from the PR author;
6. the PR is open and not draft;
7. live GitHub base branch and base SHA equal the audited base;
8. live GitHub head SHA equals the audited head.

Decision mapping remains:

```text
MERGE_APPROVED   -> APPROVE
CHANGES_REQUIRED -> REQUEST_CHANGES
BLOCKED          -> REQUEST_CHANGES
```

## Mechanical merge gate

`merge_audit_merge` performs no new code-quality reasoning. It only executes a merge after the full independent audit has already reached `MERGE_APPROVED`.

Before merging it rechecks:

1. full audit quality gate and approval SHA;
2. exact GitHub repository/PR/base branch/base SHA/head SHA;
3. expected isolated auditor identity;
4. auditor is not PR author;
5. PR is open and non-draft;
6. GitHub `reviewDecision=APPROVED`;
7. the auditor account itself has a latest `APPROVED` review;
8. `mergeStateStatus=CLEAN`;
9. CI/status evidence exists and every check is successful, neutral, or skipped.

It then uses the fixed command equivalent to:

```text
gh pr merge <PR> --repo <OWNER/NAME> --merge --match-head-commit <AUDITED_SHA>
```

No `--admin` bypass or arbitrary merge arguments are exposed. After merge, Moon verifies GitHub reports `MERGED`, the auditor as `mergedBy`, a merge commit SHA, and merge timestamp.

## Recommended branch protection

- require pull request before merging
- require at least one approving review
- dismiss stale approvals after new commits
- require Project Moon CI / `validate`
- require conversation resolution
- enforce rules for administrators when possible
- block force pushes
- block branch deletion

The intended path is:

```text
implementation
 -> developer validation / internal review
 -> push + PR + CI
 -> isolated full Merge Auditor review
 -> findings / change request if necessary
 -> new SHA -> fresh audit
 -> auditor APPROVE
 -> mechanical live GitHub gate
 -> auditor merge
 -> protected main
```

## Durable security and quality invariants

- one public Moon MCP connection;
- developer and auditor GitHub identities remain different;
- auditor credential exists only in the isolated auditor state volume;
- reviewed source is read-only in the auditor;
- repository code is not executed in the credential-bearing auditor runtime;
- public merge tools are allowlisted proxies;
- paths outside `/shared` are rejected by the proxy;
- audit is bound to repository, PR, base SHA, and head SHA;
- base or head movement invalidates approval;
- full review coverage is mandatory before approval;
- unresolved P1 findings block approval;
- risk-required validation evidence must match the exact head SHA;
- live GitHub CI and the auditor's own approval are required before merge;
- no admin bypass is used by the merge executor.
