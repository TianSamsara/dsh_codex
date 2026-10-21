$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'settings.json') -Raw | ConvertFrom-Json
$keyFile = Join-Path $PSScriptRoot 'state\local-key'
$ready = $false
if (Test-Path -LiteralPath $keyFile) {
    $bridgeKey = (Get-Content -LiteralPath $keyFile -Raw).Trim()
    try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($settings.port)/health" -Headers @{ Authorization = "Bearer $bridgeKey" } -TimeoutSec 3; $ready = $health.service -eq 'dsh-codex-bridge' } catch {}
}
if ($ready) { Write-Output 'Bridge is already running.'; return }
if (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $settings.port -State Listen -ErrorAction SilentlyContinue) { throw 'Bridge port is occupied; no process was stopped.' }
$nodePath = $settings.node
if (-not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $settings.codex -PathType Leaf)) { throw 'Codex path changed. Run Setup-Bridge.ps1 again to locate the current executable.' }
$child = Start-Process -FilePath $nodePath -ArgumentList ('"' + (Join-Path $PSScriptRoot 'server.mjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'bridge.log') -RedirectStandardError (Join-Path $PSScriptRoot 'bridge.error.log') -PassThru
$child.Id | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'bridge.pid')
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 200
    if (Test-Path -LiteralPath $keyFile) {
        $bridgeKey = (Get-Content -LiteralPath $keyFile -Raw).Trim()
        try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($settings.port)/health" -Headers @{ Authorization = "Bearer $bridgeKey" } -TimeoutSec 2; if ($health.service -eq 'dsh-codex-bridge') { Write-Output "Bridge $($health.version) is ready on port $($settings.port)."; return } } catch {}
    }
}
throw 'Bridge did not become ready. Check bridge.error.log.'
