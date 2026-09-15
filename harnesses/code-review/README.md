# Project Moon Code Review Harness

Project Moon's review engine adapts the intent → criteria → review → reflect/fix → QA workflow popularized by the MAFIA Code-Review Harness into provider-independent MCP tools.

The runtime is intentionally model-agnostic: an MCP client supplies reasoning while Project Moon owns reproducible Git context, local artifacts, worktree isolation, QA evidence, and staleness detection.

See `vendor/mafia-codereview-harness/SOURCE.md` for upstream provenance.
