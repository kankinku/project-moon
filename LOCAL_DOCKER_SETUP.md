# Local Docker MCP setup

Project Moon runs in Docker and keeps its HTTP ingress bound to `127.0.0.1:2999`. Persistent public access uses **Tailscale Funnel on the Windows host**, not a tunnel sidecar inside Docker.

```text
ChatGPT
  -> https://project-moon.<tailnet>.ts.net/mcp
  -> Tailscale Funnel (HTTPS 443)
  -> Windows 127.0.0.1:2999
  -> Docker/Nginx
  -> Project Moon :3000
```

The Tailscale DNS name is stable for the machine. `Start-PublicMcp.ps1` pins the machine name to `project-moon`, derives the actual `*.ts.net` hostname from `tailscale status --json`, writes the ignored `tunneling/.env.public`, starts Project Moon with OAuth enabled, then exposes port 2999 with a background Funnel.

## Security boundary

- Only [`shared/`](shared/) is mounted into the workmachine as `/shared`.
- The Docker socket is not mounted.
- Port `2999` remains host-loopback-only (`127.0.0.1:2999`). It is not bound to the LAN or directly to the public internet.
- Public traffic reaches the loopback listener through the host Tailscale daemon and Funnel.
- Public mode uses Project Moon built-in OAuth with `MCP_OAUTH_ENABLED=true` and `MCP_ALLOW_NO_AUTH=false`.
- There is no Cloudflare account, custom domain, tunnel token, Worker, Durable Object, or `cloudflared` runtime dependency.
- Tailscale Funnel is a public-internet ingress. Keep Project Moon OAuth enabled whenever Funnel is active.

## Local-only mode

1. Start Docker Desktop.
2. Create the non-secret local configuration:

   ```powershell
   Copy-Item tunneling/.env.local.example tunneling/.env.local
   ```

3. Start only `workmachine`:

   ```powershell
   docker compose --env-file tunneling/.env.local -f tunneling/docker-compose.local.yml up -d --build workmachine
   ```

4. Verify:

   ```powershell
   curl.exe -fsS http://127.0.0.1:2999/health
   ```

The persistent runtime state uses the Docker volume `tunneling_project-moon-local-state`.

## One-time Tailscale prerequisite

Install Tailscale on Windows and sign in to a tailnet. Funnel requires MagicDNS, HTTPS certificates, and Funnel permission on the tailnet. The first Funnel command can request approval in the Tailscale web UI.

Run public setup from an **Administrator PowerShell**. Windows unattended mode is enabled so Tailscale can remain connected when no interactive user is logged in.

You do not need to buy a domain. The public URL is the machine's stable Tailscale DNS name, for example:

```text
https://project-moon.example-tailnet.ts.net/mcp
```

## Start the public MCP endpoint

Create `.env.local` once if it does not exist:

```powershell
Copy-Item tunneling/.env.local.example tunneling/.env.local
```

Then run:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\Start-PublicMcp.ps1
```

The helper performs this sequence:

1. Checks that the Tailscale CLI is installed and the shell is elevated.
2. Runs Tailscale in unattended mode with machine hostname `project-moon`.
3. Reads `Self.DNSName` from `tailscale status --json` and requires a `*.ts.net` name.
4. Generates `tunneling/.env.public` with that stable URL and OAuth enabled.
5. Starts/rebuilds only the `workmachine` Docker service.
6. Verifies local OAuth health on `127.0.0.1:2999` before public exposure.
7. Runs `tailscale funnel --bg --yes 2999`.
8. Verifies the same Project Moon health endpoint through the public `https://...ts.net` URL.

Successful output includes:

```text
PUBLIC_MCP_URL=https://project-moon.<tailnet>.ts.net/mcp
PUBLIC_HEALTH_URL=https://project-moon.<tailnet>.ts.net/health
PUBLIC_TRANSPORT=tailscale-funnel
OAUTH_ENABLED=true
```

A background Funnel persists across device or Tailscale restarts. The ChatGPT MCP registration therefore keeps the same URL as long as this Tailscale machine identity/DNS name is retained.

## Verify OAuth and MCP

Retrieve the OAuth approval key only when the authorization page requests it:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\Get-OAuthApprovalKey.ps1
```

Run the existing end-to-end OAuth verifier:

```powershell
node .\scripts\verify-public-oauth.mjs
```

It checks discovery, unauthenticated rejection, DCR, PKCE, token exchange, refresh rotation, revocation, and authenticated MCP initialization without printing access tokens.

## Stop public access

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\Stop-PublicMcp.ps1
```

The stop helper disables the HTTPS 443 Funnel listener used by Project Moon and stops `workmachine`, while retaining the OAuth state volume and the Tailscale device identity.

## Optional NVIDIA GPU access

Add `-Gpu` to the same public start command:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\Start-PublicMcp.ps1 -Gpu
```

The GPU preflight checks host `nvidia-smi` and the Docker NVIDIA runtime. Tailscale runs on the Windows host and has no Docker GPU access.

## Optional OpenAI Secure MCP Tunnel

OpenAI Secure MCP Tunnel remains an alternative transport. Point its tunnel client at `http://127.0.0.1:2999/mcp`. Do not run it simultaneously as the canonical public transport unless you intentionally want two public ingress paths.
