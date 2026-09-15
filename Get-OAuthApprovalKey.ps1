[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$key = docker exec cokacremote-local cat /var/lib/cokacremote/oauth-approval-key
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($key)) {
    throw 'OAuth approval key is unavailable. Start the public MCP first.'
}
$key.Trim()
