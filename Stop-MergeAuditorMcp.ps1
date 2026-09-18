[CmdletBinding()]
param(
    [ValidateSet(8443, 10000)]
    [int]$HttpsPort = 8443
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$composeFile = Join-Path $projectRoot 'tunneling\docker-compose.local.yml'
$localEnv = Join-Path $projectRoot 'tunneling\.env.local'
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$auditorSecretEnv = if ([string]::IsNullOrWhiteSpace($localAppData)) {
    $null
} else {
    Join-Path (Join-Path $localAppData 'ProjectMoon') 'merge-auditor.env'
}

$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if ($tailscale) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $tailscale.Source funnel --https=$HttpsPort off 2>$null
        $funnelExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($funnelExitCode -ne 0) {
        Write-Warning "Unable to disable Tailscale Funnel on port $HttpsPort."
    }
}

if (Test-Path -LiteralPath $localEnv) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $composeArgs = @('compose', '--env-file', $localEnv)
        if ($auditorSecretEnv -and (Test-Path -LiteralPath $auditorSecretEnv -PathType Leaf)) {
            $composeArgs += @('--env-file', $auditorSecretEnv)
        }
        $composeArgs += @('-f', $composeFile, '--profile', 'merge-auditor', 'stop', 'merge-auditor')
        docker @composeArgs
        $dockerExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($dockerExitCode -ne 0) {
        throw 'Failed to stop the merge-auditor container.'
    }
}

Write-Output "MERGE_AUDITOR_FUNNEL_PORT=$HttpsPort"
Write-Output 'MERGE_AUDITOR_RUNTIME=STOPPED'
