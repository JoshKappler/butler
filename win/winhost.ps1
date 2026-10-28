# Butler's hands on Windows. One long-lived process: Butler writes one JSON
# request per line on stdin, this answers one JSON line on stdout.
#   {"id":1,"op":"click","x":10,"y":20}  ->  {"id":1,"ok":true,"result":...}
# Started by src/winhost.js with Windows PowerShell 5.1 in STA mode (clipboard).
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -Path (Join-Path $PSScriptRoot 'ButlerHost.cs') -ReferencedAssemblies System.Drawing, System.Windows.Forms
[ButlerHost]::Init()

$script:startApps = $null

function Get-Apps {
    # Get-StartApps lists every Start menu entry, Store apps included, with the
    # AppID that shell:AppsFolder launches. Cached: it takes ~1s.
    if (-not $script:startApps) {
        $script:startApps = @(Get-StartApps | ForEach-Object { @{ name = $_.Name; id = $_.AppID } })
    }
    return , $script:startApps
}

function Invoke-Op($req) {
    switch ($req.op) {
        'ping'        { return @{ pong = $true; pid = $PID } }
        'cursor'      { $p = [ButlerHost]::CursorPos(); return @{ x = $p[0]; y = $p[1] } }
        'move'        { [ButlerHost]::MoveAbs([int]$req.x, [int]$req.y); return $true }
        'move_rel'    { [ButlerHost]::MoveRel([int]$req.dx, [int]$req.dy); return $true }
        'path'        { [ButlerHost]::PlayPath([int[]]$req.flat); return $true }
        'click' {
            if ($null -ne $req.x) { [ButlerHost]::MoveAbs([int]$req.x, [int]$req.y); Start-Sleep -Milliseconds 15 }
            $count = if ($req.count) { [int]$req.count } else { 1 }
            [ButlerHost]::Click([string]$req.button, $count); return $true
        }
        'button'      { [ButlerHost]::Button([string]$req.button, [bool]$req.up); return $true }
        'scroll' {
            if ($null -ne $req.x) { [ButlerHost]::MoveAbs([int]$req.x, [int]$req.y) }
            [ButlerHost]::Scroll([int]$req.dx, [int]$req.dy); return $true
        }
        'keys'        { [ButlerHost]::Combo([string[]]$req.keys); return $true }
        'key_state'   { [ButlerHost]::KeyState([string]$req.key, [bool]$req.up); return $true }
        'type'        { [ButlerHost]::TypeText([string]$req.text); return $true }
        'monitors'    { return , [ButlerHost]::Monitors() }
        'screenshot' {
            $edge = if ($req.max_edge) { [int]$req.max_edge } else { 0 }
            if ($null -ne $req.rect) {
                $r = $req.rect
                return [ButlerHost]::ScreenshotRect([int]$r.x, [int]$r.y, [int]$r.w, [int]$r.h, $edge, [string]$req.format)
            }
            $mon = if ($null -ne $req.monitor) { [int]$req.monitor } else { -1 }
            return [ButlerHost]::Screenshot($mon, $edge, [string]$req.format)
        }
        'windows'     { return , [ButlerHost]::Windows() }
        'foreground'  { return [ButlerHost]::Foreground() }
        'focus'       { return [ButlerHost]::Focus([long]$req.hwnd) }
        'window'      { [ButlerHost]::Show([long]$req.hwnd, [string]$req.action); return $true }
        'fill'        { return [ButlerHost]::Fill([long]$req.hwnd, [string]$req.monitor) }
        'apps'        { return , (Get-Apps) }
        'open' {
            # A URL, a path, an exe name, or shell:AppsFolder\<AppID>.
            $target = [string]$req.target
            if ($req.args) { Start-Process -FilePath $target -ArgumentList $req.args } else { Start-Process -FilePath $target }
            return $true
        }
        'clipboard_get' { return (Get-Clipboard -Raw) }
        'clipboard_set' { Set-Clipboard -Value ([string]$req.text); return $true }
        default       { throw "unknown op: $($req.op)" }
    }
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    $id = $null
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        $result = Invoke-Op $req
        $out = @{ id = $id; ok = $true; result = $result }
    } catch {
        $out = @{ id = $id; ok = $false; error = $_.Exception.Message }
    }
    [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
}
