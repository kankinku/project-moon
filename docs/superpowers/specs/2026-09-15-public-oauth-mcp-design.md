# Public OAuth MCP design

## Goal

Expose the existing Docker-isolated `cokacremote` through an HTTPS URL, keep Nginx as the application reverse proxy, and require the built-in OAuth 2.1 authorization server for every MCP tool call.

## Chosen approach

Use a Cloudflare Quick Tunnel because no owned public domain or Cloudflare account credential is available. `cloudflared` runs as a second container and forwards its generated HTTPS hostname to the `workmachine` Nginx listener. Nginx remains the single application ingress and proxies `/mcp`, OAuth discovery, registration, authorization, token, revocation, and health routes to `cokacremote`.

The Quick Tunnel hostname is ephemeral. It remains usable while the `cloudflared` container keeps its current tunnel session. Restarting or recreating that container can assign a new hostname; the bootstrap script must then update `MCP_PUBLIC_URL` and recreate only `workmachine`.

## Authentication

`MCP_ALLOW_NO_AUTH=false`, `MCP_OAUTH_ENABLED=true`, and `MCP_AUTH_TOKEN` remains empty so there is no static Bearer bypass. The built-in OAuth server uses DCR, Authorization Code with PKCE S256, the `mcp:tools` scope, refresh-token rotation, and resource audience validation.

The OAuth approval key remains in `/var/lib/cokacremote/oauth-approval-key` on the named Docker state volume. A local helper prints it on demand; the key is never committed or copied into the public configuration.

## Trust boundary

Only `shared/` is mounted into the work container. The Docker socket is not mounted. Host port 2999 stays bound to `127.0.0.1`; remote traffic arrives only through `cloudflared` on the Compose network. `cloudflared` overrides the upstream Host header to `localhost`, while OAuth metadata contains the public HTTPS URL.

## Verification

The finished deployment must prove: both containers are running, `health` is available through HTTPS, unauthenticated MCP initialization returns 401, OAuth discovery advertises the public issuer/resource, DCR accepts a ChatGPT redirect URI, wrong approval keys return 401, PKCE authorization issues a code, token exchange returns access and refresh tokens, an authenticated MCP initialization succeeds, and the Docker socket is absent.
