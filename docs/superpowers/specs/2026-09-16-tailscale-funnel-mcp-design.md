# Stable Tailscale Funnel MCP design

**Status:** Current public-transport design. Supersedes the 2026-09-16 Cloudflare Named Tunnel design for Project Moon's default Windows/Docker deployment.

## Goal

Provide ChatGPT with one stable HTTPS MCP URL without purchasing a domain and without maintaining a tunnel sidecar, route updater, or public ingress secret inside the repository.

## Architecture

```text
ChatGPT
  -> https://project-moon.<tailnet>.ts.net/mcp
  -> Tailscale Funnel HTTPS listener
  -> Windows host 127.0.0.1:2999
  -> Docker port mapping
  -> Nginx
  -> Project Moon :3000
```

Tailscale owns TLS termination and the `*.ts.net` namespace. Project Moon keeps its built-in OAuth identity anchored to the same stable DNS name.

## Bootstrap order

1. Tailscale connects in Windows unattended mode with hostname `project-moon`.
2. `tailscale status --json` supplies `Self.DNSName`.
3. Project Moon writes that origin to ignored `.env.public` before container startup.
4. Docker starts only `workmachine`; no public tunnel container exists.
5. Local `/health` is verified through `127.0.0.1:2999` using the public Host value.
6. `tailscale funnel --bg --yes 2999` exposes the loopback service through HTTPS 443.
7. Public `/health` is verified through the `*.ts.net` URL.

This order avoids the old Quick Tunnel bootstrap cycle in which the public URL had to be discovered after starting the tunnel and then injected into a restarted application.

## Runtime invariants

- Host port 2999 stays bound to `127.0.0.1` only.
- Public mode always enables Project Moon OAuth and disables no-auth mode.
- `MCP_PUBLIC_URL`, OAuth issuer, OAuth resource, and ChatGPT MCP registration use the same Tailscale DNS origin.
- The canonical machine hostname is `project-moon` unless explicitly overridden.
- Funnel runs with `--bg`, so the sharing configuration resumes after Tailscale or device restarts.
- Windows Tailscale runs unattended so the connector can stay online without an interactive login session.
- No Cloudflare token, custom DNS zone, Worker, Durable Object, or cloudflared service is required.

## First-run dependency

Funnel is disabled by default at the tailnet level. Tailscale may require one-time browser approval to enable Funnel, HTTPS certificates, and the required tailnet policy capability. After approval, the same device DNS name is reused.

## Failure model

If Windows, Docker, Tailscale, or the Funnel relay path is offline, the stable DNS name does not change; requests fail until the local service returns. Tailscale Funnel is beta and has non-configurable bandwidth limits, so this transport is intended for MCP/control-plane traffic rather than bulk artifact transfer.
