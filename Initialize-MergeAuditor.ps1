[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9-]+$')]
    [string]$ExpectedLogin,

    [string]$AuthSource = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$composeFile = Join-Path $projectRoot 'tunneling\docker-compose.local.yml'
$localEnv = Join-Path $projectRoot 'tunneling\.env.local'
$localEnvExample = Join-Path $projectRoot 'tunneling\.env.local.example'
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw 'Windows LocalApplicationData path is unavailable.'
}
$auditorSecretDir = Join-Path $localAppData 'ProjectMoon'
$auditorSecretEnv = Join-Path $auditorSecretDir 'merge-auditor.env'

if ([string]::IsNullOrWhiteSpace($AuthSource)) {
    $authCandidates = @(
        (Join-Path $projectRoot 'shared\moon-merge-auditor-gh'),
        (Join-Path (Split-Path (Split-Path $projectRoot -Parent) -Parent) 'moon-merge-auditor-gh')
    )
    $AuthSource = $authCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($AuthSource)) {
        $AuthSource = $authCandidates[0]
    }
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

function New-UrlSafeToken {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

if (-not (Test-Path -LiteralPath $composeFile)) {
    throw "Missing compose file: $composeFile"
}
if (-not (Test-Path -LiteralPath $localEnvExample)) {
    throw "Missing local environment template: $localEnvExample"
}
if (-not (Test-Path -LiteralPath $AuthSource -PathType Container)) {
    throw "Merge-auditor GitHub auth source was not found: $AuthSource"
}
foreach ($name in @('hosts.yml', 'config.yml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $AuthSource $name) -PathType Leaf)) {
        throw "Missing GitHub CLI auth file: $(Join-Path $AuthSource $name)"
    }
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) { throw 'Docker CLI is not installed or not on PATH.' }
docker version --format '{{.Server.Version}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop engine is not running.' }

if (-not (Test-Path -LiteralPath $localEnv)) {
    Copy-Item -LiteralPath $localEnvExample -Destination $localEnv
}

Set-DotEnvValue -Path $localEnv -Name 'MCP_GITHUB_AUDITOR_LOGIN' -Value $ExpectedLogin
if (-not (Test-Path -LiteralPath $auditorSecretDir -PathType Container)) {
    New-Item -ItemType Directory -Path $auditorSecretDir -Force | Out-Null
}

$auditToken = Get-DotEnvValue -Path $auditorSecretEnv -Name 'MERGE_AUDITOR_AUTH_TOKEN'
if ([string]::IsNullOrWhiteSpace($auditToken)) {
    $legacyToken = Get-DotEnvValue -Path $localEnv -Name 'MERGE_AUDITOR_AUTH_TOKEN'
    if (-not [string]::IsNullOrWhiteSpace($legacyToken)) {
        $auditToken = $legacyToken
        Write-Output 'MERGE_AUDITOR_AUTH_TOKEN_MIGRATED=true'
    } else {
        $auditToken = New-UrlSafeToken
        Write-Output 'MERGE_AUDITOR_AUTH_TOKEN_GENERATED=true'
    }
    Set-DotEnvValue -Path $auditorSecretEnv -Name 'MERGE_AUDITOR_AUTH_TOKEN' -Value $auditToken
} else {
    Write-Output 'MERGE_AUDITOR_AUTH_TOKEN_GENERATED=false'
}
Set-DotEnvValue -Path $localEnv -Name 'MERGE_AUDITOR_AUTH_TOKEN' -Value ''

$composeArgs = @(
    'compose',
    '--env-file', $localEnv,
    '--env-file', $auditorSecretEnv,
    '-f', $composeFile,
    '--profile', 'merge-auditor'
)

docker @composeArgs config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Merge-auditor Docker Compose configuration is invalid.' }

$resolvedAuthSource = (Resolve-Path -LiteralPath $AuthSource).Path
$authMount = "${resolvedAuthSource}:/bootstrap-gh:ro"
$copyCommand = @'
set -eu
mkdir -p /var/lib/project-moon/gh
rm -f /var/lib/project-moon/gh/config.yml /var/lib/project-moon/gh/hosts.yml
cp /bootstrap-gh/config.yml /bootstrap-gh/hosts.yml /var/lib/project-moon/gh/
chmod 600 /var/lib/project-moon/gh/config.yml /var/lib/project-moon/gh/hosts.yml
'@

docker @composeArgs run --rm --no-deps --entrypoint sh --volume $authMount merge-auditor -lc $copyCommand
if ($LASTEXITCODE -ne 0) { throw 'Failed to import GitHub CLI credentials into the merge-auditor state volume.' }

$previousErrorActionPreference = $ErrorActionPreference
try {
    # Windows PowerShell 5.1 can promote native stderr progress output to a
    # NativeCommandError when ErrorActionPreference is Stop. Docker Compose
    # writes normal container lifecycle messages to stderr, so capture the
    # native exit code explicitly instead of treating stderr as failure.
    $ErrorActionPreference = 'Continue'
    $volumeLogin = (& docker @composeArgs run --rm --no-deps --entrypoint gh merge-auditor api user --jq '.login' 2>$null | Out-String).Trim()
    $volumeLoginExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
if ($volumeLoginExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($volumeLogin)) {
    throw 'Unable to resolve the GitHub account from the merge-auditor state volume.'
}
if (-not $volumeLogin.Equals($ExpectedLogin, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Merge-auditor account mismatch. Expected $ExpectedLogin but volume contains $volumeLogin."
}

$previousErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    docker @composeArgs up -d --build merge-auditor
    $mergeAuditorUpExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
if ($mergeAuditorUpExitCode -ne 0) { throw 'Failed to start project-moon-merge-auditor.' }

$previousErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $containerLogin = (& docker exec project-moon-merge-auditor gh api user --jq '.login' 2>$null | Out-String).Trim()
    $containerLoginExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
if ($containerLoginExitCode -ne 0 -or -not $containerLogin.Equals($ExpectedLogin, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Running merge-auditor container did not resolve the expected GitHub account.'
}

$portValue = Get-DotEnvValue -Path $localEnv -Name 'MERGE_AUDITOR_PORT'
$port = if ([string]::IsNullOrWhiteSpace($portValue)) { 3999 } else { [int]$portValue }
$health = $null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Headers @{ Authorization = "Bearer $auditToken" } -TimeoutSec 3
        if ($health.status -eq 'ok' -and $health.service -eq 'project-moon') { break }
    } catch {
        if ($attempt -eq 29) { throw }
    }
    Start-Sleep -Seconds 1
}
if (-not $health -or $health.status -ne 'ok') {
    throw 'Merge-auditor health check failed.'
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
$headers = @{
    Authorization = "Bearer $auditToken"
    Accept = 'application/json, text/event-stream'
}
$rpc = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/mcp" -Headers $headers -ContentType 'application/json' -Body $rpcBody -TimeoutSec 10
$rpcJson = $rpc | ConvertTo-Json -Depth 12 -Compress
if ($rpcJson -notmatch 'AUTHENTICATED' -or $rpcJson -notmatch [regex]::Escape($ExpectedLogin)) {
    throw 'merge_auditor_auth_status did not confirm the expected authenticated account.'
}

Write-Output "MERGE_AUDITOR_ACCOUNT=$volumeLogin"
Write-Output "MERGE_AUDITOR_PORT=$port"
Write-Output 'MERGE_AUDITOR_AUTH_STATUS=AUTHENTICATED'
Write-Output 'MERGE_AUDITOR_RUNTIME=READY'
