import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = process.cwd();
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

describe("stable Tailscale Funnel deployment", () => {
  test("Docker exposes only the host loopback gateway and has no tunnel sidecar", () => {
    for (const file of ["tunneling/docker-compose.local.yml", "tunneling/docker-compose.yml"]) {
      const compose = read(file);
      expect(compose).toContain('"127.0.0.1:2999:2999"');
      expect(compose).not.toContain("cloudflared:");
      expect(compose).not.toContain("cloudflare_tunnel_token");
      expect(compose).not.toContain("trycloudflare.com");
    }
  });

  test("obsolete Cloudflare gateway and token artifacts are absent", () => {
    expect(existsSync(join(root, "tunneling/fixed-gateway"))).toBe(false);
    expect(existsSync(join(root, "tunneling/.env.gateway.example"))).toBe(false);
    expect(existsSync(join(root, "tunneling/.cloudflare-tunnel-token.example"))).toBe(false);
  });

  test("public configuration pins OAuth to a stable ts.net origin", () => {
    const publicEnv = read("tunneling/.env.public.example");
    expect(publicEnv).toContain("MCP_PUBLIC_URL=https://project-moon.<TAILNET_NAME>.ts.net");
    expect(publicEnv).toContain("MCP_OAUTH_ENABLED=true");
    expect(publicEnv).toContain("MCP_ALLOW_NO_AUTH=false");
  });

  test("the Windows bootstrap derives and verifies the Funnel URL", () => {
    const startScript = read("Start-PublicMcp.ps1");
    expect(startScript).toContain("[string]$TailscaleHostname = 'project-moon'");
    expect(startScript).toContain("up --unattended=true --hostname=$TailscaleHostname");
    expect(startScript).toContain("status --json");
    expect(startScript).toContain("Self.DNSName");
    expect(startScript).toContain(".ts.net");
    expect(startScript).toContain("funnel --bg --yes 2999");
    expect(startScript).toContain("MCP_OAUTH_ENABLED=true");
    expect(startScript).toContain("MCP_ALLOW_NO_AUTH=false");
    expect(startScript).toContain("PUBLIC_TRANSPORT=tailscale-funnel");
    expect(startScript).not.toContain("cloudflared");
    expect(startScript).not.toContain("MOON_FIXED_GATEWAY_URL");
  });

  test("the stop helper removes only the Project Moon HTTPS Funnel listener", () => {
    const stopScript = read("Stop-PublicMcp.ps1");
    expect(stopScript).toContain("funnel --https=443 off");
    expect(stopScript).toContain("'stop', 'workmachine'");
    expect(stopScript).not.toContain("funnel reset");
    expect(stopScript).not.toContain("cloudflared");
  });

  test("current deployment docs identify Tailscale as the canonical public transport", () => {
    const localDoc = read("LOCAL_DOCKER_SETUP.md");
    const deployDoc = read("tunneling/README.md");
    expect(localDoc).toContain("Tailscale Funnel");
    expect(localDoc).toContain("project-moon.<tailnet>.ts.net/mcp");
    expect(deployDoc).toContain("Tailscale Funnel");
    expect(deployDoc).not.toContain("Cloudflare Tunnel token");
  });
});
