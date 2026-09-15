# Public OAuth MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the Docker-isolated MCP server through an HTTPS Quick Tunnel and enforce its built-in OAuth flow.

**Architecture:** A `cloudflared` sidecar creates the external HTTPS address and forwards to Nginx in `workmachine`. A PowerShell bootstrap captures the assigned hostname, writes only non-secret public runtime values, enables OAuth, and recreates the application container without restarting the tunnel.

**Tech Stack:** Docker Compose, Cloudflare Quick Tunnel, Nginx, Node.js 22, OAuth 2.1 DCR and PKCE.

---

### Task 1: Add the public sidecar and OAuth runtime

**Files:**
- Modify: `tunneling/docker-compose.local.yml`
- Create: `tunneling/.env.public.example`
- Modify: `tunneling/.gitignore`

- [x] Add a `cloudflared` service forwarding HTTPS tunnel traffic to `http://workmachine:2999` with upstream Host `localhost`.
- [x] Pass `MCP_PUBLIC_URL`, issuer/resource URLs, and strict OAuth settings into `workmachine`.
- [x] Ignore the generated `.env.public` runtime file while keeping its example tracked.
- [x] Validate with `docker compose config --quiet`.

### Task 2: Add repeatable lifecycle helpers

**Files:**
- Create: `Start-PublicMcp.ps1`
- Create: `Get-OAuthApprovalKey.ps1`
- Create: `Stop-PublicMcp.ps1`

- [x] Start or reuse `cloudflared`, obtain the current `https://*.trycloudflare.com` URL, and validate its format.
- [x] Persist only the public URL/host in `.env.public`, recreate `workmachine`, and print the MCP and health URLs.
- [x] Provide a local command that reads the approval key from the Docker state volume without storing another plaintext copy.
- [x] Provide a stop command that stops both containers without deleting the OAuth state volume.

### Task 3: Verify the public OAuth path

**Files:**
- Modify: `LOCAL_DOCKER_SETUP.md`

- [x] Confirm public `/health` returns `status=ok` and `oauthEnabled=true`.
- [x] Confirm an unauthenticated `/mcp` request returns 401 with OAuth resource metadata.
- [x] Confirm protected-resource and authorization-server discovery use the generated HTTPS URL.
- [x] Complete DCR, PKCE approval, token exchange, refresh rotation, and authenticated MCP initialization without printing tokens.
- [x] Confirm host port 2999 is loopback-only and `/var/run/docker.sock` is absent.
- [x] Document the generated URL's ephemeral lifetime and the exact start, key retrieval, verification, and stop commands.
