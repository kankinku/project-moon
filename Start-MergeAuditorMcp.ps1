[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$composeFile = Join-Path $projectRoot 'tunneling\docker-compose.local.yml'
$localEnv = Join-Path $projectRoot 'tunneling\.env.local'
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw 'Windows LocalApplicationData path is unavailable.'
}
$auditorSecretEnv = Join-Path (Join-Path $localAppData 'ProjectMoon') 'merge-auditor.env'

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

if (-not (Test-Path -LiteralPath $composeFile -PathType Leaf)) {
    throw "Missing compose file: $composeFile"
}
if (-not (Test-Path -LiteralPath $localEnv -PathType Leaf)) {
    throw "Missing $localEnv. Run Initialize-MergeAuditor.ps1 first."
}
if (-not (Test-Path -LiteralPath $auditorSecretEnv -PathType Leaf)) {
    throw 'Merge-auditor secret file is missing. Run Initialize-MergeAuditor.ps1 first.'
}

$auditToken = Get-DotEnvValue -Path $auditorSecretEnv -Name 'MERGE_AUDITOR_AUTH_TOKEN'
if ([string]::IsNullOrWhiteSpace($auditToken)) {
    throw 'MERGE_AUDITOR_AUTH_TOKEN is missing from the host-only secret file.'
}
$expectedLogin = Get-DotEnvValue -Path $localEnv -Name 'MCP_GITHUB_AUDITOR_LOGIN'
if ([string]::IsNullOrWhiteSpace($expectedLogin)) {
    throw 'MCP_GITHUB_AUDITOR_LOGIN is missing. Run Initialize-MergeAuditor.ps1 first.'
}
$portValue = Get-DotEnvValue -Path $localEnv -Name 'MERGE_AUDITOR_PORT'
$localPort = if ([string]::IsNullOrWhiteSpace($portValue)) { 3999 } else { [int]$portValue }

docker version --format '{{.Server.Version}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop engine is not running.' }

$composeArgs = @(
    'compose',
    '--env-file', $localEnv,
    '--env-file', $auditorSecretEnv,
    '-f', $composeFile,
    '--profile', 'merge-auditor'
)

docker @composeArgs config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Merge-auditor Docker Compose configuration is invalid.' }

docker @composeArgs up -d --build merge-auditor
if ($LASTEXITCODE -ne 0) { throw 'Failed to start project-moon-merge-auditor.' }

$headers = @{ Authorization = "Bearer $auditToken" }
$health = $null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$localPort/health" -Headers $headers -TimeoutSec 5
        if ($health.status -eq 'ok' -and $health.service -eq 'project-moon') { break }
    } catch {
        if ($attempt -eq 29) { throw }
    }
    Start-Sleep -Seconds 1
}
if (-not $health -or $health.status -ne 'ok') {
    throw 'Local merge-auditor health verification failed.'
}

$rpcBody = @{
    jsonrpc = '2.0'
    id = 1
    method = 'tools/call'
    params = @{
        name = 'merge_auditor_auth_status'
        arguments = @{}
    }
} | ConvertTo-Json -Depth 6 -Compress
$rpcHeaders = @{
    Authorization = "Bearer $auditToken"
    Accept = 'application/json, text/event-stream'
}
$rpc = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$localPort/mcp" -Headers $rpcHeaders -ContentType 'application/json' -Body $rpcBody -TimeoutSec 10
$rpcJson = $rpc | ConvertTo-Json -Depth 12 -Compress
if ($rpcJson -notmatch 'AUTHENTICATED' -or $rpcJson -notmatch [regex]::Escape($expectedLogin)) {
    throw 'Local merge_auditor_auth_status did not confirm the expected authenticated account.'
}

Write-Output "MERGE_AUDITOR_LOCAL_MCP_URL=http://127.0.0.1:$localPort/mcp"
Write-Output 'MERGE_AUDITOR_INTERNAL_MCP_URL=http://merge-auditor:2999/mcp'
Write-Output "MERGE_AUDITOR_ACCOUNT=$expectedLogin"
Write-Output 'MERGE_AUDITOR_TRANSPORT=private-docker-network'
Write-Output 'MERGE_AUDITOR_RUNTIME=READY'
