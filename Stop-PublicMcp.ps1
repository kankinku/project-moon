[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$composeFile = Join-Path $projectRoot 'tunneling\docker-compose.local.yml'
$localEnv = Join-Path $projectRoot 'tunneling\.env.local'
$publicEnv = Join-Path $projectRoot 'tunneling\.env.public'
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$auditorSecretEnv = if ([string]::IsNullOrWhiteSpace($localAppData)) {
    $null
} else {
    Join-Path (Join-Path $localAppData 'ProjectMoon') 'merge-auditor.env'
}

$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if ($tailscale) {
    # Only remove Project Moon's single public HTTPS listener.
    & $tailscale.Source funnel --https=443 off 2>$null
}

$composeArgs = @('compose', '--env-file', $localEnv)
if (Test-Path -LiteralPath $publicEnv) {
    $composeArgs += @('--env-file', $publicEnv)
}
if ($auditorSecretEnv -and (Test-Path -LiteralPath $auditorSecretEnv -PathType Leaf)) {
    $composeArgs += @('--env-file', $auditorSecretEnv)
}
$composeArgs += @('-f', $composeFile, '--profile', 'merge-auditor', 'stop', 'workmachine', 'merge-auditor')

docker @composeArgs
if ($LASTEXITCODE -ne 0) { throw 'Failed to stop Project Moon containers.' }

Write-Output 'PUBLIC_MCP_RUNTIME=STOPPED'
Write-Output 'MERGE_AUDITOR_RUNTIME=STOPPED'
