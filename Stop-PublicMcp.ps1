[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$composeFile = Join-Path $PSScriptRoot 'tunneling\docker-compose.local.yml'
$localEnv = Join-Path $PSScriptRoot 'tunneling\.env.local'
$publicEnv = Join-Path $PSScriptRoot 'tunneling\.env.public'

if (Test-Path -LiteralPath $publicEnv) {
    docker compose --env-file $localEnv --env-file $publicEnv -f $composeFile stop cloudflared workmachine
} else {
    docker compose --env-file $localEnv -f $composeFile stop cloudflared workmachine
}
if ($LASTEXITCODE -ne 0) { throw 'Failed to stop public MCP containers.' }
