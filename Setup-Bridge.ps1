param([string]$CodexPath, [int]$Port = 17654, [switch]$InstallPlugin)
$ErrorActionPreference = 'Stop'
$bridgeDirectory = Join-Path $PSScriptRoot 'bridge'
$settingsFile = Join-Path $bridgeDirectory 'settings.json'
$settings = if (Test-Path -LiteralPath $settingsFile) { Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{ port=$Port; node=''; codex='' } }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid port.' }
$settings.node = (Get-Command node -ErrorAction Stop).Source
if ($CodexPath) { $settings.codex = (Resolve-Path -LiteralPath $CodexPath).Path }
if (-not $settings.codex -or -not (Test-Path -LiteralPath $settings.codex -PathType Leaf)) {
    $codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
    if ($codexCommand) { $settings.codex = $codexCommand.Source }
    else {
        $codexDirectory = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
        $candidate = Get-ChildItem -LiteralPath $codexDirectory -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $candidate) { throw 'Codex was not found. Pass -CodexPath with the full path of codex.exe.' }
        $settings.codex = $candidate.FullName
    }
}
$settings | ConvertTo-Json | Set-Content -LiteralPath $settingsFile -Encoding UTF8
& (Join-Path $bridgeDirectory 'Start-Bridge.ps1')
if ($InstallPlugin) { & (Join-Path $PSScriptRoot 'plugin\install.ps1') }
Write-Output "Open Codex bridge in Harness, discover or select: $bridgeDirectory"
