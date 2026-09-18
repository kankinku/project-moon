import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = process.cwd();
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

describe("stable Tailscale Funnel deployment", () => {
  test("Docker exposes only host loopback gateways and has no tunnel sidecar", () => {
    for (const file of ["tunneling/docker-compose.local.yml", "tunneling/docker-compose.yml"]) {
      const compose = read(file);
      expect(compose).toContain('"127.0.0.1:2999:2999"');
      expect(compose).not.toContain("cloudflared:");
      expect(compose).not.toContain("cloudflare_tunnel_token");
      expect(compose).not.toContain("trycloudflare.com");
    }
    const localCompose = read("tunneling/docker-compose.local.yml");
    expect(localCompose).toContain('"127.0.0.1:${MERGE_AUDITOR_PORT:-3999}:2999"');
  });

  test("obsolete Cloudflare gateway and token artifacts are absent", () => {
    expect(existsSync(join(root, "tunneling/fixed-gateway"))).toBe(false);
    expect(existsSync(join(root, "tunneling/.env.gateway.example"))).toBe(false);
    expect(existsSync(join(root, "tunneling/.cloudflare-tunnel-token.example"))).toBe(false);
  });

  test("public configuration pins OAuth to the single stable ts.net origin", () => {
    const publicEnv = read("tunneling/.env.public.example");
    expect(publicEnv).toContain("MCP_PUBLIC_URL=https://project-moon.<TAILNET_NAME>.ts.net");
    expect(publicEnv).toContain("MCP_OAUTH_ENABLED=true");
    expect(publicEnv).toContain("MCP_ALLOW_NO_AUTH=false");
  });

  test("the Windows public bootstrap derives one Funnel URL and can start the isolated auditor backend", () => {
    const startScript = read("Start-PublicMcp.ps1");
    expect(startScript).toContain("[string]$TailscaleHostname = 'project-moon'");
    expect(startScript).toContain("up --unattended=true --hostname=$TailscaleHostname");
    expect(startScript).not.toContain("set --hostname=$TailscaleHostname");
    expect(startScript).not.toContain("status --json");
    expect(startScript).toContain("funnel status");
    expect(startScript).toContain("https://[A-Za-z0-9.-]+\\.ts\\.net/?");
    expect(startScript).toContain("funnel --bg --yes 2999");
    expect(startScript).toContain("MCP_OAUTH_ENABLED=true");
    expect(startScript).toContain("MCP_ALLOW_NO_AUTH=false");
    expect(startScript).toContain("merge-auditor.env");
    expect(startScript).toContain("$auditorEnabled = -not [string]::IsNullOrWhiteSpace($auditToken)");
    expect(startScript).toContain("Set-DotEnvValue -Path $localEnv -Name 'MCP_GITHUB_AUDITOR_LOGIN'");
    expect(startScript).toContain("MERGE_AUDITOR_ACCOUNT_RECOVERED=");
    expect(startScript).toContain("MERGE_AUDITOR_PROXY_ENABLED");
    expect(startScript).toContain("'--profile', 'merge-auditor'");
    expect(startScript).toContain("merge_auditor_auth_status");
    expect(startScript).toContain("MERGE_AUDITOR_TRANSPORT=private-docker-network");
    expect(startScript).toContain("PUBLIC_TRANSPORT=tailscale-funnel");
    expect(startScript).not.toContain("8443");
    expect(startScript).not.toContain("cloudflared");
    expect(startScript).not.toContain("MOON_FIXED_GATEWAY_URL");
  });

  test("the public stop helper removes only the 443 Funnel and stops both runtimes", () => {
    const stopScript = read("Stop-PublicMcp.ps1");
    expect(stopScript).toContain("funnel --https=443 off");
    expect(stopScript).toContain("'workmachine', 'merge-auditor'");
    expect(stopScript).not.toContain("8443");
    expect(stopScript).not.toContain("funnel reset");
    expect(stopScript).not.toContain("cloudflared");
  });

  test("merge auditor stays private behind the single public Moon", () => {
    const startScript = read("Start-MergeAuditorMcp.ps1");
    const stopScript = read("Stop-MergeAuditorMcp.ps1");
    const initializeScript = read("Initialize-MergeAuditor.ps1");
    const compose = read("tunneling/docker-compose.local.yml");
    const localEnv = read("tunneling/.env.local.example");

    expect(startScript).toContain("MERGE_AUDITOR_INTERNAL_MCP_URL=http://merge-auditor:2999/mcp");
    expect(startScript).toContain("MERGE_AUDITOR_TRANSPORT=private-docker-network");
    expect(startScript).toContain("Authorization = \"Bearer $auditToken\"");
    expect(startScript).not.toContain("tailscale");
    expect(startScript).not.toContain("funnel");
    expect(startScript).not.toContain("8443");
    expect(stopScript).not.toContain("tailscale");
    expect(stopScript).not.toContain("funnel");
    expect(stopScript).not.toContain("8443");

    expect(compose).toContain('MCP_MERGE_AUDITOR_INTERNAL_URL: "http://merge-auditor:2999/mcp"');
    expect(compose).toContain('MCP_MERGE_AUDITOR_INTERNAL_TOKEN: "${MERGE_AUDITOR_AUTH_TOKEN:-}"');
    expect(compose).toContain('MCP_ALLOWED_HOSTS: "localhost,127.0.0.1,merge-auditor"');
    expect(compose).toContain("source: ../shared");
    expect(compose).toContain("target: /audit/shared");
    expect(compose).toContain("read_only: true");
    expect(compose).not.toContain("MERGE_AUDITOR_PUBLIC_URL");

    expect(localEnv).toContain("MERGE_AUDITOR_PROXY_ENABLED=false");
    expect(localEnv).not.toContain("MERGE_AUDITOR_AUTH_TOKEN=");
    expect(localEnv).not.toContain("MERGE_AUDITOR_PUBLIC_URL=");

    expect(initializeScript).toContain("LocalApplicationData");
    expect(initializeScript).toContain("merge-auditor.env");
    expect(initializeScript).toContain("MERGE_AUDITOR_PROXY_READY=true");
    expect(initializeScript).not.toContain("Set-DotEnvValue -Path $localEnv -Name 'MERGE_AUDITOR_PROXY_ENABLED' -Value 'true'");
    expect(initializeScript).toContain("Set-DotEnvValue -Path $localEnv -Name 'MERGE_AUDITOR_AUTH_TOKEN' -Value ''");
  });

  test("current deployment docs identify Tailscale as the only public transport", () => {
    const localDoc = read("LOCAL_DOCKER_SETUP.md");
    const deployDoc = read("tunneling/README.md");
    expect(localDoc).toContain("Tailscale Funnel");
    expect(localDoc).toContain("project-moon.<tailnet>.ts.net/mcp");
    expect(localDoc).not.toContain("ts.net:8443/mcp");
    expect(deployDoc).toContain("Tailscale Funnel");
    expect(deployDoc).not.toContain("HTTPS `8443`");
    expect(deployDoc).not.toContain("Cloudflare Tunnel token");
  });
});
