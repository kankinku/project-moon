# Stable Named Tunnel MCP design

> **Superseded (2026-09-16):** Project Moon now uses host-level Tailscale Funnel as the default public transport. See `docs/superpowers/specs/2026-09-16-tailscale-funnel-mcp-design.md`.


**Status:** Current design. Supersedes the 2026-09-15 Quick Tunnel public-MCP design for persistent ChatGPT registration.

## Goal

Expose Project Moon at one stable HTTPS MCP URL without detecting, storing, translating, or reconciling ephemeral Quick Tunnel hostnames.

## Architecture

```text
ChatGPT
  -> https://mcp.example.com/mcp
  -> Cloudflare edge
  -> remotely managed Cloudflare Tunnel
  -> cloudflared container
  -> http://localhost:2999
  -> Nginx
  -> Project Moon :3000
```

`MCP_PUBLIC_URL`, OAuth issuer, OAuth resource, and the ChatGPT MCP registration all use the same stable public hostname.

## Cloudflare configuration

Create a remotely managed Cloudflare Tunnel and configure a published application hostname such as `mcp.example.com` with service URL `http://localhost:2999`. The hostname is owned by the Cloudflare zone and does not change when `cloudflared` or Docker restarts.

The connector receives only the remotely managed Tunnel token. Project Moon stores that token in the local-only `tunneling/.cloudflare-tunnel-token` file and mounts it into `cloudflared` as a Docker Compose secret. `cloudflared` reads it with `--token-file`; the token is not passed as a command-line value and is not committed to Git.

## Runtime invariants

- Quick Tunnel and `*.trycloudflare.com` URLs are not part of the production path.
- No Worker, Durable Object, route updater, or origin reconciliation service exists.
- The public hostname must be an HTTPS origin with no path, query, fragment, or credentials.
- `Start-PublicMcp.ps1` rejects `*.trycloudflare.com` as `MCP_PUBLIC_URL`.
- The Cloudflare published application must route to `http://localhost:2999` because `cloudflared` shares the `workmachine` network namespace.
- Project Moon built-in OAuth remains enabled for the public path.
- Local-only access remains bound to `127.0.0.1:2999`.

## Failure model

If the local PC, Docker, or `cloudflared` is offline, the stable hostname remains the same but requests fail until the connector returns. Restarting the connector does not require changing ChatGPT MCP configuration. For higher availability, multiple `cloudflared` replicas can attach to the same remotely managed Tunnel.
