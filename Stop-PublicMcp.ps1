[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$composeFile = Join-Path $PSScriptRoot 'tunneling\docker-compose.local.yml'
$localEnv = Join-Path $PSScriptRoot 'tunneling\.env.local'
$publicEnv = Join-Path $PSScriptRoot 'tunneling\.env.public'

$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if ($tailscale) {
    # Only remove Project Moon's default Funnel HTTPS listener; do not reset unrelated ports.
    & $tailscale.Source funnel --https=443 off 2>$null
}

$composeArgs = @('compose', '--env-file', $localEnv)
if (Test-Path -LiteralPath $publicEnv) {
    $composeArgs += @('--env-file', $publicEnv)
}
$composeArgs += @('-f', $composeFile, 'stop', 'workmachine')

docker @composeArgs
if ($LASTEXITCODE -ne 0) { throw 'Failed to stop public MCP container.' }
