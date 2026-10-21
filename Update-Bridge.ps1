param(
    [Parameter(Mandatory=$true)][string]$BridgeRoot,
    [ValidateRange(0,600)][int]$WaitSeconds = 60,
    [string]$ResultFile
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
# Harness may inherit PowerShell 7 module paths; Windows PowerShell needs its own modules first.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules')
$targetRoot = (Resolve-Path -LiteralPath $BridgeRoot).Path
$sourceRoot = Join-Path $PSScriptRoot 'bridge'
$files = @('server.mjs', 'client.mjs', 'manager.mjs', 'protocol.mjs')
$lock = $null
$drained = $false
$changed = $false
$newChild = $null
$backup = Join-Path $targetRoot ('.bridge-backups\' + [guid]::NewGuid().ToString())
function Get-Health { return Invoke-RestMethod -Uri "$address/health" -Headers $headers -TimeoutSec 3 }
function Confirm-Owner($owner) {
    $normalizedCommand = ($owner.CommandLine -replace '/', '\').ToLowerInvariant()
    $runtimeNames = @('node', 'node.exe', [IO.Path]::GetFileName($settings.node))
    $quotedPath = '"' + $scriptPath.ToLowerInvariant() + '"'
    $barePathPattern = '(?:^|\s)' + [regex]::Escape($scriptPath.ToLowerInvariant()) + '(?:\s|$)'
    if (-not $owner -or ($normalizedCommand.IndexOf($quotedPath) -lt 0 -and $normalizedCommand -notmatch $barePathPattern) -or $owner.Name -notin $runtimeNames) { throw 'Process identity could not be verified; no process was stopped.' }
}
function Get-Owner {
    $listener = Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $settings.port -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { return $null }
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    Confirm-Owner $owner
    return $owner
}
function Stop-OwnedBridge($owner) {
    $current = Get-Owner
    if (-not $current) { return }
    if (-not $owner -or $current.ProcessId -ne $owner.ProcessId -or $current.CreationDate -ne $owner.CreationDate) { throw 'Listener changed during update; no process was stopped.' }
    # Stop only this verified bridge and its warm Codex child processes.
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $current.ProcessId /T /F 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the verified bridge process.' }
    Wait-Process -Id $current.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
}
function Start-UpdatedBridge {
    $savedNodeMode = $env:ELECTRON_RUN_AS_NODE
    try {
        if ($settings.electronNode) { $env:ELECTRON_RUN_AS_NODE = '1' } else { $env:ELECTRON_RUN_AS_NODE = $null }
        $child = Start-Process -FilePath $nodePath -ArgumentList ('"' + $scriptPath + '"') -WorkingDirectory $targetRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $targetRoot 'bridge.log') -RedirectStandardError (Join-Path $targetRoot 'bridge.error.log') -PassThru
    } finally { $env:ELECTRON_RUN_AS_NODE = $savedNodeMode }
    $child.Id | Set-Content -LiteralPath (Join-Path $targetRoot 'bridge.pid')
    return $child
}
function Wait-Ready([string]$version) {
    $readyDeadline = (Get-Date).AddSeconds(12)
    while ((Get-Date) -lt $readyDeadline) {
        Start-Sleep -Milliseconds 250
        if ($version -and $newChild -and $newChild.HasExited) { return $false }
        try { $result = Get-Health; if ($result.service -eq 'dsh-codex-bridge' -and (-not $version -or $result.version -eq $version)) { return $true } } catch {}
    }
    return $false
}
try {
    $lock = [IO.File]::Open((Join-Path $targetRoot '.bridge-update.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $settingsFile = Join-Path $targetRoot 'settings.json'
    $keyFile = Join-Path $targetRoot 'state\local-key'
    $settingsHash = (Get-FileHash -LiteralPath $settingsFile -Algorithm SHA256).Hash
    $keyHash = (Get-FileHash -LiteralPath $keyFile -Algorithm SHA256).Hash
    $settings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
    $bridgeKey = (Get-Content -LiteralPath $keyFile -Raw).Trim()
    if ($bridgeKey -notmatch '^[a-fA-F0-9]{64}$' -or $settings.port -lt 1024 -or $settings.port -gt 65535) { throw 'Invalid local bridge configuration.' }
    $headers = @{ Authorization = "Bearer $bridgeKey" }
    $address = "http://127.0.0.1:$($settings.port)"
    $scriptPath = Join-Path $targetRoot 'server.mjs'
    foreach ($file in $files) { if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $file) -PathType Leaf)) { throw "Missing update source: $file" } }
    $protocol = Get-Content -LiteralPath (Join-Path $sourceRoot 'protocol.mjs') -Raw
    if ($protocol -notmatch "VERSION\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'") { throw 'Invalid source bridge version.' }
    $targetVersion = $Matches[1]
    $nodePath = $settings.node
    if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node -ErrorAction Stop).Source }
    $owner = Get-Owner
    if ($owner) {
        $health = Get-Health
        if ($health.service -ne 'dsh-codex-bridge') { throw 'The configured port belongs to another service.' }
        $deadline = (Get-Date).AddSeconds($WaitSeconds)
        # Wait first: a busy timeout leaves the old service accepting requests.
        while ($health.active -ne 0) {
            if ((Get-Date) -ge $deadline) { throw 'Bridge still has active requests. No files changed; retry after the request finishes.' }
            Start-Sleep -Milliseconds 500
            $health = Get-Health
        }
        Invoke-RestMethod -Method Post -Uri "$address/admin/drain" -Headers $headers -TimeoutSec 3 | Out-Null
        $drained = $true
        do {
            $health = Get-Health
            if ($health.active -eq 0) { break }
            if ((Get-Date) -ge $deadline) { throw 'Bridge still has active requests. No files changed; retry after the request finishes.' }
            Start-Sleep -Milliseconds 500
        } while ($true)
    }
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    foreach ($file in $files) { if (Test-Path -LiteralPath (Join-Path $targetRoot $file) -PathType Leaf) { Copy-Item -LiteralPath (Join-Path $targetRoot $file) -Destination (Join-Path $backup $file) } }
    if ((Get-FileHash -LiteralPath $settingsFile).Hash -ne $settingsHash -or (Get-FileHash -LiteralPath $keyFile).Hash -ne $keyHash) { throw 'Bridge configuration changed; retry the update.' }
    if ($owner) { Stop-OwnedBridge $owner }
    $changed = $true
    foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $targetRoot $file) -Force }
    $newChild = Start-UpdatedBridge
    if (-not (Wait-Ready $targetVersion)) { throw 'Updated bridge did not become ready.' }
    $verified = Get-Owner
    if (-not $verified -or $verified.ProcessId -ne $newChild.Id) { throw 'Updated listener identity did not match.' }
    if ((Get-FileHash -LiteralPath $settingsFile).Hash -ne $settingsHash -or (Get-FileHash -LiteralPath $keyFile).Hash -ne $keyHash) { throw 'Bridge configuration changed during update.' }
    $resultJSON = @{ version = $targetVersion; backup = $backup; preserved = $true } | ConvertTo-Json -Compress
    if ($ResultFile) { [IO.File]::WriteAllText($ResultFile, $resultJSON, (New-Object Text.UTF8Encoding($false))) } else { Write-Output $resultJSON }
} catch {
    $failure = $_.Exception.Message
    if ($changed) {
        try {
            if ($newChild -and -not $newChild.HasExited) {
                # A hung startup may not have opened a port yet. Verify the child directly.
                $failedOwner = Get-CimInstance Win32_Process -Filter "ProcessId=$($newChild.Id)"
                Confirm-Owner $failedOwner
                & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $failedOwner.ProcessId /T /F 2>$null | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'Could not stop the failed new bridge.' }
            }
            foreach ($file in $files) {
                $saved = Join-Path $backup $file
                if (Test-Path -LiteralPath $saved) { Copy-Item -LiteralPath $saved -Destination (Join-Path $targetRoot $file) -Force }
                elseif (Test-Path -LiteralPath (Join-Path $targetRoot $file)) { Remove-Item -LiteralPath (Join-Path $targetRoot $file) }
            }
            if ($owner) { Start-UpdatedBridge | Out-Null; if (-not (Wait-Ready '')) { throw 'Old bridge could not restart; check its log.' } }
            $failure += ' Previous source restored.'
        } catch { $failure += ' Recovery needs attention: ' + $_.Exception.Message }
    } elseif ($drained) {
        try { Invoke-RestMethod -Method Post -Uri "$address/admin/resume" -Headers $headers -TimeoutSec 3 | Out-Null } catch { $failure += ' Old bridge drain expires within 90 seconds.' }
    }
    [Console]::Error.WriteLine("BRIDGE_UPDATE_FAILED: $failure")
    if ($ResultFile) { [IO.File]::WriteAllText($ResultFile, (@{ error = $failure } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false))) }
    exit 1
} finally { if ($lock) { $lock.Dispose() } }
