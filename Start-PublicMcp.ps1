[CmdletBinding()]
param(
    [switch]$Gpu,
    [ValidatePattern('^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')]
    [string]$TailscaleHostname = 'project-moon'
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$composeFile = Join-Path $projectRoot 'tunneling\docker-compose.local.yml'
$gpuComposeFile = Join-Path $projectRoot 'tunneling\docker-compose.gpu.yml'
$localEnv = Join-Path $projectRoot 'tunneling\.env.local'
$publicEnv = Join-Path $projectRoot 'tunneling\.env.public'

if (-not (Test-Path -LiteralPath $localEnv)) {
    throw "Missing $localEnv. Copy tunneling/.env.local.example first."
}

$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $tailscale) {
    throw 'Tailscale is not installed or tailscale.exe is not on PATH. Install Tailscale for Windows first.'
}

if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        throw 'Start-PublicMcp.ps1 must run from an Administrator PowerShell because Tailscale Funnel and unattended mode require elevated permissions on Windows.'
    }
}

# Connect/authenticate if needed and enable Windows unattended mode using the documented
# Windows command. Keep hostname mutation separate so existing non-default `tailscale up`
# settings are not accidentally reset.
& $tailscale.Source up --unattended=true
if ($LASTEXITCODE -ne 0) {
    throw 'Tailscale failed to connect or enable unattended mode. Complete Tailscale login and retry.'
}

& $tailscale.Source set --hostname=$TailscaleHostname
if ($LASTEXITCODE -ne 0) {
    throw "Tailscale failed to set the machine hostname to '$TailscaleHostname'."
}

# Some Windows Tailscale builds can emit informational text on stderr while stdout is valid
# JSON. Never merge stderr into the JSON stream. If stdout still has a harmless banner, trim
# everything outside the outermost JSON object before parsing.
$statusLines = @(& $tailscale.Source status --json 2>$null)
$statusExitCode = $LASTEXITCODE
$statusRaw = ($statusLines -join [Environment]::NewLine).Trim()
if ($statusExitCode -ne 0) {
    $statusText = (& $tailscale.Source status 2>&1 | Out-String).Trim()
    throw "tailscale status failed: $statusText"
}
$jsonStart = $statusRaw.IndexOf('{')
$jsonEnd = $statusRaw.LastIndexOf('}')
if ($jsonStart -lt 0 -or $jsonEnd -lt $jsonStart) {
    throw 'tailscale status --json returned no JSON object.'
}
$statusJson = $statusRaw.Substring($jsonStart, $jsonEnd - $jsonStart + 1)
try {
    $tailscaleStatus = $statusJson | ConvertFrom-Json
} catch {
    throw 'tailscale status --json returned malformed JSON.'
}
if ($tailscaleStatus.BackendState -ne 'Running') {
    throw "Tailscale is not connected. BackendState=$($tailscaleStatus.BackendState)"
}

$dnsName = [string]$tailscaleStatus.Self.DNSName
$dnsName = $dnsName.Trim().TrimEnd('.')
if (-not $dnsName -or -not $dnsName.EndsWith('.ts.net', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Tailscale did not provide a ts.net DNS name. Enable MagicDNS for the tailnet, then retry.'
}
$publicUrl = "https://$dnsName"

# OAuth identity is anchored to the stable Tailscale DNS name before the application starts.
$runtime = "MCP_PUBLIC_URL=$publicUrl`nMCP_ENDPOINT=/mcp`nMCP_OAUTH_ENABLED=true`nMCP_ALLOW_NO_AUTH=false`n"
[System.IO.File]::WriteAllText($publicEnv, $runtime, [System.Text.UTF8Encoding]::new($false))

docker version --format '{{.Server.Version}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop engine is not running.' }

if ($Gpu) {
    $hostNvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $hostNvidiaSmi) { throw 'NVIDIA GPU preflight failed: host nvidia-smi is unavailable.' }

    & $hostNvidiaSmi.Source --query-gpu=name,driver_version,memory.total --format=csv,noheader | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'NVIDIA GPU preflight failed: host nvidia-smi returned an error.' }

    $dockerRuntimes = docker info --format '{{json .Runtimes}}' | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $dockerRuntimes.PSObject.Properties.Name -notcontains 'nvidia') {
        throw 'NVIDIA GPU preflight failed: Docker does not advertise the nvidia runtime.'
    }
}

$composeArgs = @('compose', '--env-file', $localEnv, '--env-file', $publicEnv, '-f', $composeFile)
if ($Gpu) { $composeArgs += @('-f', $gpuComposeFile) }

docker @composeArgs config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose configuration validation failed.' }

docker @composeArgs up -d --build workmachine
if ($LASTEXITCODE -ne 0) { throw 'Failed to start Project Moon.' }

# Verify the local origin before exposing it to the public internet.
$localHealth = $null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $localHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:2999/health' -TimeoutSec 5
        if ($localHealth.status -eq 'ok' -and $localHealth.service -eq 'project-moon' -and $localHealth.oauthEnabled -eq $true) { break }
    } catch {
        if ($attempt -eq 29) { throw }
    }
    Start-Sleep -Seconds 1
}
if (-not $localHealth -or $localHealth.status -ne 'ok' -or $localHealth.oauthEnabled -ne $true) {
    throw 'Local OAuth health verification failed before enabling Tailscale Funnel.'
}

# A background Funnel persists across Tailscale and device restarts. Port 2999 is
# proxied through the default public HTTPS listener (443) to 127.0.0.1:2999.
$funnelOutput = & $tailscale.Source funnel --bg --yes 2999 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host $funnelOutput
    throw 'Failed to enable Tailscale Funnel. If Tailscale presents an approval URL, approve Funnel for this tailnet and retry.'
}

$publicHealth = $null
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
        $publicHealth = Invoke-RestMethod -Uri "$publicUrl/health" -TimeoutSec 10
        if ($publicHealth.status -eq 'ok' -and $publicHealth.service -eq 'project-moon' -and $publicHealth.oauthEnabled -eq $true) { break }
    } catch {
        if ($attempt -eq 59) {
            & $tailscale.Source funnel status | Write-Host
            throw
        }
    }
    Start-Sleep -Seconds 2
}
if (-not $publicHealth -or $publicHealth.status -ne 'ok' -or $publicHealth.service -ne 'project-moon' -or $publicHealth.oauthEnabled -ne $true) {
    throw 'Tailscale Funnel OAuth health verification failed.'
}

if ($Gpu) {
    $containerGpu = docker exec project-moon-local nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
    if ($LASTEXITCODE -ne 0) { throw 'NVIDIA GPU verification failed inside project-moon-local.' }
    Write-Output "GPU_DEVICE=$containerGpu"
}

Write-Output "PUBLIC_MCP_URL=$publicUrl/mcp"
Write-Output "PUBLIC_HEALTH_URL=$publicUrl/health"
Write-Output "TAILSCALE_DNS_NAME=$dnsName"
Write-Output 'PUBLIC_TRANSPORT=tailscale-funnel'
Write-Output 'OAUTH_ENABLED=true'
Write-Output "GPU_ENABLED=$($Gpu.ToString().ToLowerInvariant())"
