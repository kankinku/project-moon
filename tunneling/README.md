# Project Moon workmachine deployment

Project Moon runs in Docker while **Tailscale Funnel runs on the host** and provides the stable public HTTPS address used by ChatGPT MCP.

```text
ChatGPT
  -> https://project-moon.<tailnet>.ts.net/mcp
  -> Tailscale Funnel
  -> host 127.0.0.1:2999
  -> Nginx
  -> Project Moon :3000
```

There is no tunnel container, domain purchase, DNS record, or tunnel credential stored in this repository.

## Docker boundary

`docker-compose.local.yml` publishes Nginx only to `127.0.0.1:2999`. Tailscale Funnel proxies the host's loopback service to public HTTPS. The Docker socket is not mounted and only `shared/` is bind-mounted into the workmachine.

## Local configuration

```powershell
Copy-Item tunneling/.env.local.example tunneling/.env.local
```

Local-only start:

```powershell
docker compose --env-file tunneling/.env.local -f tunneling/docker-compose.local.yml up -d --build workmachine
```

## Public start on Windows

Install Tailscale, sign in, then use Administrator PowerShell:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\Start-PublicMcp.ps1
```

The helper pins the Tailscale machine name to `project-moon`, obtains its stable `*.ts.net` URL directly from a persistent background Funnel, generates the ignored `.env.public`, and starts Project Moon with OAuth enabled behind `127.0.0.1:2999`.

Tailscale Funnel requires MagicDNS, HTTPS support, and Funnel permission on the tailnet. A first-time setup can require browser approval.

## Private merge auditor backend

After `Initialize-MergeAuditor.ps1` has stored the dedicated secondary GitHub login in `project-moon-auditor-state`, the normal `Start-PublicMcp.ps1` helper starts the auditor together with the developer runtime when the host-only auditor secret is present.

```text
ChatGPT
  -> Tailscale Funnel HTTPS 443
  -> Project Moon workmachine
  -> http://merge-auditor:2999/mcp (private Docker network)
  -> project-moon-merge-auditor
```

The auditor is **not** exposed through a second public Funnel. It is protected by a host-generated internal Bearer credential stored outside the shared workspace at `%LOCALAPPDATA%\ProjectMoon\merge-auditor.env`, and it retains its own GitHub CLI identity in the `project-moon-auditor-state` volume. The workmachine can proxy only the allowlisted `merge_audit_*` workflow; it does not receive the auditor GitHub credential.

For local recovery/diagnostics only:

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-MergeAuditorMcp.ps1
powershell -ExecutionPolicy Bypass -File .\Stop-MergeAuditorMcp.ps1
```

These helpers do not create or remove any additional Tailscale Funnel listener.

## Generic host deployment

`tunneling/docker-compose.yml` also exposes `127.0.0.1:2999` only. On a Linux host, install Tailscale on the host OS and expose the same loopback port with Funnel; set `MCP_PUBLIC_URL` in `.env` to that host's stable `*.ts.net` URL.

## OAuth

Public mode must use:

```dotenv
MCP_ENDPOINT=/mcp
MCP_OAUTH_ENABLED=true
MCP_ALLOW_NO_AUTH=false
```

On Windows these values and `MCP_PUBLIC_URL` are generated automatically in `tunneling/.env.public` by `Start-PublicMcp.ps1`.

Retrieve the approval key only when needed:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\Get-OAuthApprovalKey.ps1
```

Verify the complete OAuth/MCP flow:

```powershell
node .\scripts\verify-public-oauth.mjs
```

## Stop

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\Stop-PublicMcp.ps1
```

This disables the Project Moon HTTPS Funnel listener and stops the workmachine without deleting persistent OAuth state.
