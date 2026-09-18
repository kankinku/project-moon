[CmdletBinding()]
param()

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

if (Test-Path -LiteralPath $localEnv) {
    $composeArgs = @('compose', '--env-file', $localEnv)
    if ($auditorSecretEnv -and (Test-Path -LiteralPath $auditorSecretEnv -PathType Leaf)) {
        $composeArgs += @('--env-file', $auditorSecretEnv)
    }
    $composeArgs += @('-f', $composeFile, '--profile', 'merge-auditor', 'stop', 'merge-auditor')
    docker @composeArgs
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to stop the merge-auditor container.'
    }
}

Write-Output 'MERGE_AUDITOR_RUNTIME=STOPPED'
