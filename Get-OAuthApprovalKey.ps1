[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$key = docker exec project-moon-local cat /var/lib/project-moon/oauth-approval-key
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($key)) {
    throw 'OAuth approval key is unavailable. Start the public MCP first.'
}
$key.Trim()
