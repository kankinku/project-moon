# Local Docker MCP setup

This deployment runs `cokacremote` in a Docker container and exposes its HTTP endpoint only to this Windows computer at `127.0.0.1:2999`.

The local environment fetches `main` but validates that it resolves to source commit `d7ceca3`; a changed upstream branch makes the build fail rather than silently changing the server. Update both `COKACREMOTE_REF` and `COKACREMOTE_REVISION` deliberately when you choose to update the server.

The build overlays the audited local `package-lock.json` on that pinned source before `npm ci`. This keeps the application source reproducible while allowing security-only transitive dependency updates to be verified and deployed.

## Security boundary

- Only [`shared/`](shared/) is mounted into the container as `/shared`.
- The Docker socket is not mounted. The MCP cannot create, stop, or inspect host Docker containers.
- The endpoint has no built-in Bearer or OAuth authentication because it listens only on loopback. Do not change the port mapping to `2999:2999` or `0.0.0.0:2999:2999`.
- OpenAI Secure MCP Tunnel is the only intended remote path. It authenticates the OpenAI product to the tunnel control plane.
- Tools can permanently alter files below `shared/`. Do not place credentials or unrelated personal files there.

## Run locally

1. Start Docker Desktop and wait until its engine is running.
2. Copy the local-only template:

   ```powershell
   Copy-Item tunneling/.env.local.example tunneling/.env.local
   ```

3. Build and start:

   ```powershell
   docker compose --env-file tunneling/.env.local -f tunneling/docker-compose.local.yml up -d --build
   ```

4. Verify the endpoint:

   ```powershell
   curl.exe -fsS http://127.0.0.1:2999/health
   docker compose --env-file tunneling/.env.local -f tunneling/docker-compose.local.yml ps
   ```

5. Inspect or stop it when needed:

   ```powershell
   docker compose --env-file tunneling/.env.local -f tunneling/docker-compose.local.yml logs -f
   docker compose --env-file tunneling/.env.local -f tunneling/docker-compose.local.yml down
   ```

The persistent runtime state uses the Docker volume `tunneling_cokacremote-local-state`, separate from host project files.

## Connect through OpenAI Secure MCP Tunnel

1. In [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels), create a tunnel and obtain its `tunnel_id` plus a runtime API key. Do not save either value in this repository.
2. Download `tunnel-client` from the Platform tunnel page and configure it on this PC to reach `http://127.0.0.1:2999/mcp`.
3. Keep `tunnel-client run` healthy; it requires outbound HTTPS but no inbound public port.
4. In ChatGPT developer-mode app creation, choose **Tunnel** and select or paste the `tunnel_id`.

The tunnel client and the Docker health endpoint must be running whenever ChatGPT needs these MCP tools.

## Public HTTPS URL with built-in OAuth

Run the bootstrap script from PowerShell:

```powershell
Set-Location C:\Users\<user>\Desktop\cokacremote
pwsh -NoProfile -ExecutionPolicy Bypass -File .\Start-PublicMcp.ps1
```

It starts a Cloudflare Quick Tunnel, records its generated public URL in the ignored `tunneling/.env.public` file, enables built-in OAuth, and recreates only the work container. Retrieve the approval key only when the OAuth approval page asks for it:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\Get-OAuthApprovalKey.ps1
```

Verify the complete public DCR, PKCE, token, refresh, and authenticated MCP flow without printing any token:

```powershell
node .\scripts\verify-public-oauth.mjs
```

Stop the public endpoint without deleting the persistent OAuth state volume:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\Stop-PublicMcp.ps1
```

The `trycloudflare.com` hostname belongs to the current Quick Tunnel process. If `cokacremote-cloudflared` is restarted or recreated, run `Start-PublicMcp.ps1` again and update the MCP URL in ChatGPT. A stable production URL requires an owned domain and a named tunnel.
