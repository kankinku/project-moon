# Local Docker MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run project-moon in Docker with only a dedicated Desktop workspace mounted and a loopback-only HTTP endpoint for OpenAI Secure MCP Tunnel.

**Architecture:** Docker Compose builds the repository's existing `tunneling/Dockerfile` and starts one `workmachine` container. The container exposes TCP 2999 only on `127.0.0.1`; it receives no Docker socket and mounts only `shared/` at `/shared`. Built-in authentication is disabled only because no public ingress exists; OpenAI Secure MCP Tunnel provides the remote connection boundary.

**Tech Stack:** Docker Desktop, Docker Compose, Ubuntu 24.04, Nginx, Node.js 22, project-moon, OpenAI Secure MCP Tunnel.

---

### Task 1: Add local Compose configuration

**Files:**
- Create: `tunneling/docker-compose.local.yml`
- Create: `tunneling/.env.local.example`

- [ ] **Step 1: Define the single-container Docker service**

Create `tunneling/docker-compose.local.yml` with a `workmachine` service built from the existing Dockerfile. Bind `127.0.0.1:2999:2999`, bind only `../shared` to `/shared`, and set `MCP_ALLOW_NO_AUTH=true`, `MCP_OAUTH_ENABLED=false`, `MCP_DEFAULT_CWD=/shared`, and `MCP_ALLOWED_HOSTS=localhost,127.0.0.1`.

- [ ] **Step 2: Define the non-secret local environment template**

Create `tunneling/.env.local.example` with `TZ=Asia/Seoul`, `WORKMACHINE_IMAGE=project-moon-local:0.1.0`. Do not include tunnel credentials or API keys.

- [ ] **Step 3: Validate Compose rendering**

Run: `docker compose --env-file tunneling/.env.local -f tunneling/docker-compose.local.yml config`

Expected: one `workmachine` service, a loopback-only port mapping, and no `cloudflared` service.

### Task 2: Document the trust boundary and tunnel connection

**Files:**
- Create: `LOCAL_DOCKER_SETUP.md`

- [ ] **Step 1: Document commands and boundaries**

Document Docker Desktop startup, `docker compose up -d --build`, health verification, logs, stop/restart, the sole `/shared` host mount, absence of Docker socket access, and that deleting a file in `/shared` changes the host folder.

- [ ] **Step 2: Document Secure MCP Tunnel handoff**

Document that a user-created `tunnel_id` and runtime API key are required, that `tunnel-client` must forward to `http://127.0.0.1:2999/mcp`, and that ChatGPT developer-mode app setup selects the tunnel. Never write credentials into repository files.

### Task 3: Start and verify the isolated runtime

**Files:**
- Modify: `tunneling/.env.local` (local, ignored configuration copied from example)

- [ ] **Step 1: Materialize the ignored local environment file**

Copy `tunneling/.env.local.example` to `tunneling/.env.local` without adding credentials.

- [ ] **Step 2: Build and start the container**

Run: `docker compose --env-file tunneling/.env.local -f tunneling/docker-compose.local.yml up -d --build`

Expected: `workmachine` becomes healthy and no port other than loopback 2999 is published.

- [ ] **Step 3: Verify health and containment**

Run: `curl.exe -fsS http://127.0.0.1:2999/health` and `docker inspect project-moon-local --format '{{json .HostConfig.Binds}}'`.

Expected: health JSON reports `status: ok`; inspection reports exactly the Desktop `shared` bind and no Docker socket bind.

- [ ] **Step 4: Record the final runtime state**

Run: `docker compose --env-file tunneling/.env.local -f tunneling/docker-compose.local.yml ps`.

Expected: `workmachine` is running and healthy.
