# Claude Code Notification hook: tells Butler the moment a Claude session is
# waiting on Josh (a permission prompt, or idle at a question). herdr's screen
# detection catches the same thing; this is the exact signal. Always exits 0 so
# a stopped Butler never breaks Claude.
#
# ~/.claude/settings.json:
#   "hooks": { "Notification": [ { "hooks": [ { "type": "command",
#     "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\path\\to\\butler\\win\\hooks\\butler-notify.ps1" } ] } ] }
try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $token = (Get-Content "$env:APPDATA\Butler\state\token" -Raw).Trim()
    $body = @{ source = 'claude'; cwd = $payload.cwd; message = $payload.message } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri 'http://127.0.0.1:47113/event' -Method Post -Body $body `
        -ContentType 'application/json' -Headers @{ 'X-Butler-Token' = $token } -TimeoutSec 2 | Out-Null
} catch { }
exit 0
