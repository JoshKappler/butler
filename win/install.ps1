# One-time Butler setup on Windows. Safe to re-run.
#   powershell -ExecutionPolicy Bypass -File win\install.ps1
# 1. npm install   2. %APPDATA%\Butler with .env and config.json
# 3. Startup shortcuts for Butler and butler-keys.ahk   4. start both now
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$data = Join-Path $env:APPDATA 'Butler'
$startup = [Environment]::GetFolderPath('Startup')

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

Step 'Checking tools'
foreach ($tool in 'node', 'npm') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH. Install Node 22+ first." }
}
$ahk = @(
    "$env:LOCALAPPDATA\Programs\AutoHotkey2\v2\AutoHotkey64.exe",
    "$env:LOCALAPPDATA\Programs\AutoHotkey\v2\AutoHotkey64.exe",
    "$env:ProgramFiles\AutoHotkey\v2\AutoHotkey64.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $ahk) { Write-Warning 'AutoHotkey v2 not found; Pause and Home will not work until it is installed.' }
foreach ($opt in 'claude', 'codex') {
    if (-not (Get-Command $opt -ErrorAction SilentlyContinue)) { Write-Warning "$opt CLI not on PATH; agents of that kind will not start." }
}
if (-not (Get-Command herdr -ErrorAction SilentlyContinue)) { Write-Warning 'herdr not on PATH; set herdr.bin in config.json, or agents will not open in herdr.' }

Step 'npm install'
Push-Location $repo
try { npm install --no-fund --no-audit } finally { Pop-Location }

Step "Settings in $data"
New-Item -ItemType Directory -Force -Path (Join-Path $data 'state') | Out-Null
$envFile = Join-Path $data '.env'
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $repo '.env.example') $envFile
    Write-Host "Created $envFile. Put GEMINI_API_KEY in it, unless it is already set in your environment." -ForegroundColor Yellow
}
$cfgFile = Join-Path $data 'config.json'
if (-not (Test-Path $cfgFile)) {
    Set-Content -Path $cfgFile -Encoding UTF8 -Value "{`n  `"_note`": `"Overrides for config.default.json in the repo. Only keys you set here change.`"`n}"
    Write-Host "Created $cfgFile for your overrides."
}

Step 'Startup shortcuts'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $startup 'butler.lnk'))
$lnk.TargetPath = Join-Path $repo 'win\start-butler.cmd'
$lnk.WorkingDirectory = $repo
$lnk.WindowStyle = 7
$lnk.Save()
if ($ahk) {
    $lnk = $shell.CreateShortcut((Join-Path $startup 'butler-keys.lnk'))
    $lnk.TargetPath = $ahk
    $lnk.Arguments = "`"$(Join-Path $repo 'win\butler-keys.ahk')`""
    $lnk.WorkingDirectory = Join-Path $repo 'win'
    $lnk.Save()
}

Step 'Starting'
Start-Process -FilePath (Join-Path $repo 'win\start-butler.cmd') -WorkingDirectory $repo -WindowStyle Hidden
if ($ahk) { Start-Process -FilePath $ahk -ArgumentList "`"$(Join-Path $repo 'win\butler-keys.ahk')`"" }

Write-Host "`nDone. Hold Pause and talk. Tap Pause for the dock." -ForegroundColor Green
Write-Host 'If an older Pause-key assistant is still running, quit it or remove its Pause binding; two scripts cannot both own the key.'
