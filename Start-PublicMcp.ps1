[CmdletBinding()]
param(
    [switch]$Gpu
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$composeFile = Join-Path $projectRoot 'tunneling\docker-compose.local.yml'
$gpuComposeFile = Join-Path $projectRoot 'tunneling\docker-compose.gpu.yml'
$localEnv = Join-Path $projectRoot 'tunneling\.env.local'
$publicEnv = Join-Path $projectRoot 'tunneling\.env.public'

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

$composeArgs = @('compose', '--env-file', $localEnv, '-f', $composeFile)
if ($Gpu) { $composeArgs += @('-f', $gpuComposeFile) }

docker @composeArgs up -d --build workmachine
if ($LASTEXITCODE -ne 0) { throw 'Failed to start workmachine.' }
docker @composeArgs up -d cloudflared
if ($LASTEXITCODE -ne 0) { throw 'Failed to start cloudflared.' }

$publicUrl = $null
for ($attempt = 0; $attempt -lt 30 -and -not $publicUrl; $attempt++) {
    $logs = docker logs project-moon-cloudflared 2>&1 | Out-String
    $matches = [regex]::Matches($logs, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($matches.Count -gt 0) { $publicUrl = $matches[$matches.Count - 1].Value }
    if (-not $publicUrl) { Start-Sleep -Seconds 2 }
}
if (-not $publicUrl) { throw 'Cloudflare Quick Tunnel did not provide a public URL.' }

$runtime = "MCP_PUBLIC_URL=$publicUrl`nMCP_ENDPOINT=/mcp`nMCP_OAUTH_ENABLED=true`nMCP_ALLOW_NO_AUTH=false`n"
[System.IO.File]::WriteAllText($publicEnv, $runtime, [System.Text.UTF8Encoding]::new($false))

$publicComposeArgs = @('compose', '--env-file', $localEnv, '--env-file', $publicEnv, '-f', $composeFile)
if ($Gpu) { $publicComposeArgs += @('-f', $gpuComposeFile) }

docker @publicComposeArgs up -d --no-deps workmachine
if ($LASTEXITCODE -ne 0) { throw 'Failed to enable OAuth on workmachine.' }

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri "$publicUrl/health" -TimeoutSec 10
        if ($health.status -eq 'ok' -and $health.oauthEnabled -eq $true) { break }
    } catch { if ($attempt -eq 29) { throw } }
    Start-Sleep -Seconds 2
}
if ($health.status -ne 'ok' -or $health.oauthEnabled -ne $true) { throw 'Public OAuth health verification failed.' }

if ($Gpu) {
    $containerGpu = docker exec project-moon-local nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
    if ($LASTEXITCODE -ne 0) { throw 'NVIDIA GPU verification failed inside project-moon-local.' }
    Write-Output "GPU_DEVICE=$containerGpu"
}

Write-Output "PUBLIC_MCP_URL=$publicUrl/mcp"
Write-Output "PUBLIC_HEALTH_URL=$publicUrl/health"
Write-Output 'OAUTH_ENABLED=true'
Write-Output "GPU_ENABLED=$($Gpu.ToString().ToLowerInvariant())"
