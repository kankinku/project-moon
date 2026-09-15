[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function ConvertFrom-NvidiaCsvRow {
    param(
        [Parameter(Mandatory)]
        [string]$Row
    )

    $fields = $Row -split ',\s*', 3
    if ($fields.Count -ne 3) { throw "Unexpected nvidia-smi CSV output: $Row" }

    [pscustomobject]@{
        name = $fields[0]
        driverVersion = $fields[1]
        memoryTotalMiB = [int]$fields[2]
    }
}

try {
    $hostNvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $hostNvidiaSmi) { throw 'Host nvidia-smi is unavailable.' }

    $hostRows = @(& $hostNvidiaSmi.Source --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits)
    if ($LASTEXITCODE -ne 0 -or $hostRows.Count -eq 0) { throw 'Host nvidia-smi query failed.' }

    $dockerRuntimes = docker info --format '{{json .Runtimes}}' | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $dockerRuntimes.PSObject.Properties.Name -notcontains 'nvidia') {
        throw 'Docker does not advertise the nvidia runtime.'
    }

    $inspect = docker inspect cokacremote-local | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $inspect.Count -ne 1) { throw 'cokacremote-local is unavailable.' }

    $gpuRequest = @($inspect[0].HostConfig.DeviceRequests) | Where-Object {
        ($_.Capabilities | ConvertTo-Json -Compress) -match 'gpu'
    }
    if (-not $gpuRequest) { throw 'cokacremote-local has no GPU device request.' }

    $containerRows = @(docker exec cokacremote-local nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits)
    if ($LASTEXITCODE -ne 0 -or $containerRows.Count -eq 0) { throw 'Container nvidia-smi query failed.' }

    $containerSummary = docker exec cokacremote-local nvidia-smi
    if ($LASTEXITCODE -ne 0) { throw 'Container nvidia-smi summary failed.' }
    $cudaMatch = [regex]::Match(($containerSummary -join "`n"), 'CUDA Version:\s*([0-9.]+)')

    [pscustomobject]@{
        status = 'PASS'
        host = @($hostRows | ForEach-Object { ConvertFrom-NvidiaCsvRow -Row $_ })
        dockerRuntime = 'nvidia'
        containerDeviceRequest = 'PASS'
        container = [pscustomobject]@{
            gpus = @($containerRows | ForEach-Object { ConvertFrom-NvidiaCsvRow -Row $_ })
            cudaVersion = if ($cudaMatch.Success) { $cudaMatch.Groups[1].Value } else { $null }
        }
        secretsPrinted = $false
    } | ConvertTo-Json -Depth 6
} catch {
    [pscustomobject]@{
        status = 'FAIL'
        error = $_.Exception.Message
        secretsPrinted = $false
    } | ConvertTo-Json
    exit 1
}
