param(
    [Parameter(Mandatory=$true)][string]$BridgeRoot,
    [int]$WaitSeconds = 60
)
$ErrorActionPreference = 'Stop'
$targetRoot = (Resolve-Path -LiteralPath $BridgeRoot).Path
$sourceRoot = Join-Path $PSScriptRoot 'bridge'
$settings = Get-Content -LiteralPath (Join-Path $targetRoot 'settings.json') -Raw | ConvertFrom-Json
$bridgeKey = (Get-Content -LiteralPath (Join-Path $targetRoot 'state\local-key') -Raw).Trim()
$headers = @{ Authorization = "Bearer $bridgeKey" }
$address = "http://127.0.0.1:$($settings.port)"
$scriptPath = Join-Path $targetRoot 'server.mjs'
$backup = Join-Path $targetRoot ('.bridge-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$files = @('server.mjs', 'client.mjs', 'manager.mjs', 'protocol.mjs')
foreach ($file in $files) { if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $file))) { throw "Missing update source: $file" } }
$health = $null
try { $health = Invoke-RestMethod -Uri "$address/health" -Headers $headers -TimeoutSec 3 } catch {}
if ($health -and $health.service -ne 'dsh-codex-bridge') { throw 'The configured port belongs to another service.' }
if ($health) {
    if ($health.version) { Invoke-RestMethod -Method Post -Uri "$address/admin/drain" -Headers $headers -TimeoutSec 3 | Out-Null }
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    do {
        $health = Invoke-RestMethod -Uri "$address/health" -Headers $headers -TimeoutSec 3
        if ($health.active -eq 0) { break }
        if ((Get-Date) -ge $deadline) { throw 'Bridge still has active requests. No files were changed; retry after the request finishes.' }
        Start-Sleep -Milliseconds 500
    } while ($true)
}
$listener = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $settings.port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    $normalizedCommand = ($owner.CommandLine -replace '/', '\').ToLowerInvariant()
    $runtimeNames = @('node', 'node.exe', [IO.Path]::GetFileName($settings.node))
    if (-not $owner -or $normalizedCommand.IndexOf($scriptPath.ToLowerInvariant()) -lt 0 -or $owner.Name -notin $runtimeNames) { throw 'Listener identity could not be verified; no process was stopped.' }
}
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($file in $files) {
    $oldFile = Join-Path $targetRoot $file
    if (Test-Path -LiteralPath $oldFile -PathType Leaf) { Copy-Item -LiteralPath $oldFile -Destination (Join-Path $backup $file) }
}
$nodePath = $settings.node
if (-not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node -ErrorAction Stop).Source }
function Start-UpdatedBridge {
    $savedNodeMode = $env:ELECTRON_RUN_AS_NODE
    try {
        if ($settings.electronNode) { $env:ELECTRON_RUN_AS_NODE = '1' }
        $child = Start-Process -FilePath $nodePath -ArgumentList ('"' + $scriptPath + '"') -WorkingDirectory $targetRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $targetRoot 'bridge.log') -RedirectStandardError (Join-Path $targetRoot 'bridge.error.log') -PassThru
    } finally { $env:ELECTRON_RUN_AS_NODE = $savedNodeMode }
    $child.Id | Set-Content -LiteralPath (Join-Path $targetRoot 'bridge.pid')
    return $child
}
if ($listener) { Stop-Process -Id $listener.OwningProcess -ErrorAction Stop; Wait-Process -Id $listener.OwningProcess -Timeout 10 -ErrorAction SilentlyContinue }
$newChild = $null
try {
    foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $targetRoot $file) -Force }
    $newChild = Start-UpdatedBridge
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 200
        try { $result = Invoke-RestMethod -Uri "$address/health" -Headers $headers -TimeoutSec 2; if ($result.version -eq '1.1.0' -and $result.capabilities.session_continuation) { $ready = $true; break } } catch {}
    }
    if (-not $ready) { throw 'Updated bridge did not become ready.' }
    Write-Output "Bridge 1.1.0 is running on port $($settings.port). Key and settings preserved. Backup: $backup"
} catch {
    if ($newChild -and -not $newChild.HasExited) { Stop-Process -Id $newChild.Id -ErrorAction SilentlyContinue }
    foreach ($file in $files) {
        $saved = Join-Path $backup $file
        if (Test-Path -LiteralPath $saved) { Copy-Item -LiteralPath $saved -Destination (Join-Path $targetRoot $file) -Force }
    }
    Start-UpdatedBridge | Out-Null
    throw
}
