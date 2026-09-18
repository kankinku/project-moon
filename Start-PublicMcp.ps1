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
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$auditorSecretEnv = if ([string]::IsNullOrWhiteSpace($localAppData)) {
    $null
} else {
    Join-Path (Join-Path $localAppData 'ProjectMoon') 'merge-auditor.env'
}

function Get-DotEnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line.StartsWith("$Name=")) { return $line.Substring($Name.Length + 1) }
    }
    return $null
}

if (-not (Test-Path -LiteralPath $localEnv)) {
    throw "Missing $localEnv. Copy tunneling/.env.local.example first."
}

$expectedAuditorLogin = Get-DotEnvValue -Path $localEnv -Name 'MCP_GITHUB_AUDITOR_LOGIN'
$auditToken = if ($auditorSecretEnv) {
    Get-DotEnvValue -Path $auditorSecretEnv -Name 'MERGE_AUDITOR_AUTH_TOKEN'
} else {
    $null
}
$auditorEnabled =
    -not [string]::IsNullOrWhiteSpace($expectedAuditorLogin) -and
    -not [string]::IsNullOrWhiteSpace($auditToken)
$env:MERGE_AUDITOR_PROXY_ENABLED = $auditorEnabled.ToString().ToLowerInvariant()

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

# Tailscale requires every previously configured non-default `up` flag to be repeated.
# Project Moon owns both unattended mode and this machine name, so keep them together on
# every `tailscale up` invocation. This also makes reruns idempotent after the hostname has
# already been changed to project-moon.
& $tailscale.Source up --unattended=true --hostname=$TailscaleHostname
if ($LASTEXITCODE -ne 0) {
    throw 'Tailscale failed to connect or enable unattended mode. Complete Tailscale login and retry.'
}

# Docker must be available before changing the public ingress. Stop an older workmachine
# first so a stale OAuth configuration is never exposed while the Funnel URL is discovered.
docker version --format '{{.Server.Version}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop engine is not running.' }

$stopArgs = @('compose', '--env-file', $localEnv, '-f', $composeFile, 'stop', 'workmachine')
docker @stopArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to stop the previous Project Moon workmachine before Funnel setup.' }

# Funnel itself prints the canonical public URL. Use that output directly instead of
# avoiding native-command JSON parsing, which varies across Windows PowerShell versions.
# If a rerun does not echo the URL, fall back to the
# human-readable Funnel status, which also contains the configured HTTPS URL.
$funnelOutput = (& $tailscale.Source funnel --bg --yes 2999 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    Write-Host $funnelOutput
    throw 'Failed to enable Tailscale Funnel. If Tailscale presents an approval URL, approve Funnel for this tailnet and retry.'
}

$urlMatch = [regex]::Match($funnelOutput, 'https://[A-Za-z0-9.-]+\.ts\.net/?', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
if (-not $urlMatch.Success) {
    $funnelStatus = (& $tailscale.Source funnel status 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "tailscale funnel status failed: $funnelStatus" }
    $urlMatch = [regex]::Match($funnelStatus, 'https://[A-Za-z0-9.-]+\.ts\.net/?', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
if (-not $urlMatch.Success) {
    throw 'Tailscale Funnel did not report a public *.ts.net HTTPS URL.'
}

$publicUrl = $urlMatch.Value.TrimEnd('/')
try {
    $publicUri = [Uri]$publicUrl
} catch {
    throw "Tailscale Funnel returned an invalid public URL: $publicUrl"
}
$dnsName = $publicUri.Host
if (-not $dnsName.EndsWith('.ts.net', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Tailscale Funnel returned an unexpected hostname: $dnsName"
}

# OAuth identity is anchored to the exact URL reported by Funnel before Project Moon starts.
$runtime = "MCP_PUBLIC_URL=$publicUrl`nMCP_ENDPOINT=/mcp`nMCP_OAUTH_ENABLED=true`nMCP_ALLOW_NO_AUTH=false`n"
[System.IO.File]::WriteAllText($publicEnv, $runtime, [System.Text.UTF8Encoding]::new($false))

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

$composeArgs = @('compose', '--env-file', $localEnv, '--env-file', $publicEnv)
if ($auditorEnabled) {
    $composeArgs += @('--env-file', $auditorSecretEnv)
}
$composeArgs += @('-f', $composeFile)
if ($Gpu) { $composeArgs += @('-f', $gpuComposeFile) }
if ($auditorEnabled) { $composeArgs += @('--profile', 'merge-auditor') }

docker @composeArgs config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose configuration validation failed.' }

$upArgs = $composeArgs + @('up', '-d', '--build', 'workmachine')
if ($auditorEnabled) { $upArgs += 'merge-auditor' }
docker @upArgs
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

if ($auditorEnabled) {
    $auditorPortValue = Get-DotEnvValue -Path $localEnv -Name 'MERGE_AUDITOR_PORT'
    $auditorPort = if ([string]::IsNullOrWhiteSpace($auditorPortValue)) { 3999 } else { [int]$auditorPortValue }
    $auditorHeaders = @{ Authorization = "Bearer $auditToken" }
    $auditorHealth = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $auditorHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$auditorPort/health" -Headers $auditorHeaders -TimeoutSec 5
            if ($auditorHealth.status -eq 'ok' -and $auditorHealth.service -eq 'project-moon') { break }
        } catch {
            if ($attempt -eq 29) { throw }
        }
        Start-Sleep -Seconds 1
    }
    if (-not $auditorHealth -or $auditorHealth.status -ne 'ok') {
        throw 'Local merge-auditor health verification failed.'
    }

    $auditorRpcBody = @{
        jsonrpc = '2.0'
        id = 1
        method = 'tools/call'
        params = @{
            name = 'merge_auditor_auth_status'
            arguments = @{}
        }
    } | ConvertTo-Json -Depth 6 -Compress
    $auditorRpcHeaders = @{
        Authorization = "Bearer $auditToken"
        Accept = 'application/json, text/event-stream'
    }
    $auditorRpc = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$auditorPort/mcp" -Headers $auditorRpcHeaders -ContentType 'application/json' -Body $auditorRpcBody -TimeoutSec 10
    $auditorRpcJson = $auditorRpc | ConvertTo-Json -Depth 12 -Compress
    if ($auditorRpcJson -notmatch 'AUTHENTICATED' -or $auditorRpcJson -notmatch [regex]::Escape($expectedAuditorLogin)) {
        throw 'Merge-auditor did not confirm the expected authenticated GitHub account.'
    }
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
Write-Output "MERGE_AUDITOR_PROXY_ENABLED=$($auditorEnabled.ToString().ToLowerInvariant())"
if ($auditorEnabled) {
    Write-Output "MERGE_AUDITOR_ACCOUNT=$expectedAuditorLogin"
    Write-Output 'MERGE_AUDITOR_TRANSPORT=private-docker-network'
}
Write-Output "GPU_ENABLED=$($Gpu.ToString().ToLowerInvariant())"
