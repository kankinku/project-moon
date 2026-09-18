[CmdletBinding()]
param(
    [ValidateSet(8443, 10000)]
    [int]$HttpsPort = 8443,

    [ValidatePattern('^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')]
    [string]$TailscaleHostname = 'project-moon'
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$composeFile = Join-Path $projectRoot 'tunneling\docker-compose.local.yml'
$localEnv = Join-Path $projectRoot 'tunneling\.env.local'
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw 'Windows LocalApplicationData path is unavailable.'
}
$auditorSecretDir = Join-Path $localAppData 'ProjectMoon'
$auditorSecretEnv = Join-Path $auditorSecretDir 'merge-auditor.env'

function Get-DotEnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line.StartsWith("$Name=")) { return $line.Substring($Name.Length + 1) }
    }
    return $null
}

function Set-DotEnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value
    )

    $content = if (Test-Path -LiteralPath $Path) {
        [System.IO.File]::ReadAllText($Path)
    } else {
        ''
    }
    $pattern = '(?m)^' + [regex]::Escape($Name) + '=.*$'
    $line = "$Name=$Value"
    if ([regex]::IsMatch($content, $pattern)) {
        $content = [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $line })
    } else {
        if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) { $content += "`n" }
        $content += "$line`n"
    }
    [System.IO.File]::WriteAllText($Path, $content, [System.Text.UTF8Encoding]::new($false))
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Command,
        [string]$FailureMessage = 'Native command failed.'
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Command
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) { throw $FailureMessage }
}

if (-not (Test-Path -LiteralPath $composeFile -PathType Leaf)) {
    throw "Missing compose file: $composeFile"
}
if (-not (Test-Path -LiteralPath $localEnv -PathType Leaf)) {
    throw "Missing $localEnv. Run Initialize-MergeAuditor.ps1 first."
}

if (-not (Test-Path -LiteralPath $auditorSecretDir -PathType Container)) {
    New-Item -ItemType Directory -Path $auditorSecretDir -Force | Out-Null
}

$auditToken = Get-DotEnvValue -Path $auditorSecretEnv -Name 'MERGE_AUDITOR_AUTH_TOKEN'
if ([string]::IsNullOrWhiteSpace($auditToken)) {
    $legacyToken = Get-DotEnvValue -Path $localEnv -Name 'MERGE_AUDITOR_AUTH_TOKEN'
    if ([string]::IsNullOrWhiteSpace($legacyToken)) {
        throw 'MERGE_AUDITOR_AUTH_TOKEN is missing. Run Initialize-MergeAuditor.ps1 first.'
    }
    $auditToken = $legacyToken
    Set-DotEnvValue -Path $auditorSecretEnv -Name 'MERGE_AUDITOR_AUTH_TOKEN' -Value $auditToken
    Write-Output 'MERGE_AUDITOR_SECRET_MIGRATED=true'
} else {
    Write-Output 'MERGE_AUDITOR_SECRET_MIGRATED=false'
}
Set-DotEnvValue -Path $localEnv -Name 'MERGE_AUDITOR_AUTH_TOKEN' -Value ''

$expectedLogin = Get-DotEnvValue -Path $localEnv -Name 'MCP_GITHUB_AUDITOR_LOGIN'
if ([string]::IsNullOrWhiteSpace($expectedLogin)) {
    throw 'MCP_GITHUB_AUDITOR_LOGIN is missing. Run Initialize-MergeAuditor.ps1 first.'
}

$portValue = Get-DotEnvValue -Path $localEnv -Name 'MERGE_AUDITOR_PORT'
$localPort = if ([string]::IsNullOrWhiteSpace($portValue)) { 3999 } else { [int]$portValue }

$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $tailscale) {
    throw 'Tailscale is not installed or tailscale.exe is not on PATH.'
}

if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        throw 'Start-MergeAuditorMcp.ps1 must run from an Administrator PowerShell.'
    }
}

Invoke-NativeCommand -Command {
    & $tailscale.Source up --unattended=true --hostname=$TailscaleHostname
} -FailureMessage 'Tailscale failed to connect or enable unattended mode.'

Invoke-NativeCommand -Command {
    docker version --format '{{.Server.Version}}' | Out-Null
} -FailureMessage 'Docker Desktop engine is not running.'

$composeArgs = @(
    'compose',
    '--env-file', $localEnv,
    '--env-file', $auditorSecretEnv,
    '-f', $composeFile,
    '--profile', 'merge-auditor'
)

Invoke-NativeCommand -Command {
    docker @composeArgs config --quiet
} -FailureMessage 'Merge-auditor Docker Compose configuration is invalid.'

Invoke-NativeCommand -Command {
    docker @composeArgs up -d --build merge-auditor
} -FailureMessage 'Failed to start the merge-auditor container.'

$headers = @{ Authorization = "Bearer $auditToken" }
$localHealth = $null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $localHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$localPort/health" -Headers $headers -TimeoutSec 5
        if ($localHealth.status -eq 'ok' -and $localHealth.service -eq 'project-moon') { break }
    } catch {
        if ($attempt -eq 29) { throw }
    }
    Start-Sleep -Seconds 1
}
if (-not $localHealth -or $localHealth.status -ne 'ok') {
    throw 'Local merge-auditor health verification failed.'
}

$localRpcBody = @{
    jsonrpc = '2.0'
    id = 1
    method = 'tools/call'
    params = @{
        name = 'merge_auditor_auth_status'
        arguments = @{}
    }
} | ConvertTo-Json -Depth 6 -Compress
$localRpcHeaders = @{
    Authorization = "Bearer $auditToken"
    Accept = 'application/json, text/event-stream'
}
$localRpc = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$localPort/mcp" -Headers $localRpcHeaders -ContentType 'application/json' -Body $localRpcBody -TimeoutSec 10
$localRpcJson = $localRpc | ConvertTo-Json -Depth 12 -Compress
if ($localRpcJson -notmatch 'AUTHENTICATED' -or $localRpcJson -notmatch [regex]::Escape($expectedLogin)) {
    throw 'Local merge_auditor_auth_status did not confirm the expected authenticated account.'
}

$previousErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $funnelOutput = (& $tailscale.Source funnel --https=$HttpsPort --bg --yes $localPort 2>&1 | Out-String).Trim()
    $funnelExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
if ($funnelExitCode -ne 0) {
    Write-Host $funnelOutput
    throw 'Failed to enable the merge-auditor Tailscale Funnel.'
}

$dnsMatch = [regex]::Match($funnelOutput, '([A-Za-z0-9.-]+\.ts\.net)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
if (-not $dnsMatch.Success) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $funnelStatus = (& $tailscale.Source funnel status 2>&1 | Out-String).Trim()
        $funnelStatusExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($funnelStatusExitCode -ne 0) { throw "tailscale funnel status failed: $funnelStatus" }
    $dnsMatch = [regex]::Match($funnelStatus, '([A-Za-z0-9.-]+\.ts\.net)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
if (-not $dnsMatch.Success) {
    throw 'Tailscale Funnel did not report a public *.ts.net hostname.'
}

$dnsName = $dnsMatch.Groups[1].Value.ToLowerInvariant()
$publicUrl = "https://${dnsName}:$HttpsPort"
Set-DotEnvValue -Path $localEnv -Name 'MERGE_AUDITOR_PUBLIC_URL' -Value $publicUrl
Set-DotEnvValue -Path $localEnv -Name 'MERGE_AUDITOR_ALLOWED_HOSTS' -Value "localhost,127.0.0.1,$dnsName"

Invoke-NativeCommand -Command {
    docker @composeArgs up -d --build --force-recreate merge-auditor
} -FailureMessage 'Failed to recreate merge-auditor with its public host allowlist.'

$publicHealth = $null
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
        $publicHealth = Invoke-RestMethod -Uri "$publicUrl/health" -Headers $headers -TimeoutSec 10
        if ($publicHealth.status -eq 'ok' -and $publicHealth.service -eq 'project-moon') { break }
    } catch {
        if ($attempt -eq 59) {
            & $tailscale.Source funnel status | Write-Host
            throw
        }
    }
    Start-Sleep -Seconds 2
}
if (-not $publicHealth -or $publicHealth.status -ne 'ok') {
    throw 'Public merge-auditor Funnel health verification failed.'
}

$publicRpc = Invoke-RestMethod -Method Post -Uri "$publicUrl/mcp" -Headers $localRpcHeaders -ContentType 'application/json' -Body $localRpcBody -TimeoutSec 15
$publicRpcJson = $publicRpc | ConvertTo-Json -Depth 12 -Compress
if ($publicRpcJson -notmatch 'AUTHENTICATED' -or $publicRpcJson -notmatch [regex]::Escape($expectedLogin)) {
    throw 'Public merge_auditor_auth_status did not confirm the expected authenticated account.'
}

Write-Output "MERGE_AUDITOR_PUBLIC_MCP_URL=$publicUrl/mcp"
Write-Output "MERGE_AUDITOR_PUBLIC_HEALTH_URL=$publicUrl/health"
Write-Output "MERGE_AUDITOR_ACCOUNT=$expectedLogin"
Write-Output "MERGE_AUDITOR_FUNNEL_PORT=$HttpsPort"
Write-Output 'MERGE_AUDITOR_AUTH_MODE=BEARER'
Write-Output 'MERGE_AUDITOR_SECRET_STORAGE=LOCALAPPDATA'
Write-Output 'MERGE_AUDITOR_RUNTIME=READY'
