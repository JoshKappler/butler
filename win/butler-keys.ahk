; Butler keys. The talk key (Pause unless the dock's settings chose another,
; saved in %APPDATA%\Butler\state\ptt-key) does two things:
;   hold        talk (push-to-talk)
;   tap         open or close the dock
; The key is swallowed, so the focused app never sees it. Butler tells taps
; from holds; this script only reports down and up on 127.0.0.1.
#Requires AutoHotkey v2.0
#SingleInstance Force
InstallKeybdHook

; ── config ──────────────────────────────────────────────────────────────────
PTT_KEY := "Pause"
try PTT_KEY := Trim(FileRead(EnvGet("APPDATA") "\Butler\state\ptt-key")) || "Pause"
PORT := 47113
TOKEN_FILE := EnvGet("APPDATA") "\Butler\state\token"
BUTLER_START := A_ScriptDir "\start-butler.cmd"

; ── transport ───────────────────────────────────────────────────────────────
; Synchronous on purpose: loopback answers in about a millisecond, and a
; release must never overtake its press.
Post(path) {
    static token := ""
    static lastLaunch := 0
    if (token = "") {
        try token := Trim(FileRead(TOKEN_FILE))
    }
    try {
        req := ComObject("WinHttp.WinHttpRequest.5.1")
        req.SetTimeouts(250, 250, 500, 800)
        req.Open("POST", "http://127.0.0.1:" PORT path, false)
        req.SetRequestHeader("X-Butler-Token", token)
        req.SetRequestHeader("Content-Type", "application/json")
        req.Send("{}")
        if (req.Status = 401)
            token := ""  ; Butler minted a new token; reread next time
        return req.ResponseText
    } catch {
        ; Butler is not running: start it, at most once a minute.
        if (A_TickCount - lastLaunch > 60000 && FileExist(BUTLER_START)) {
            lastLaunch := A_TickCount
            Run(BUTLER_START, A_ScriptDir, "Hide")
            TrayTip("Starting Butler", "Butler", 1)
        }
    }
}

; ── keys ────────────────────────────────────────────────────────────────────
held := false

PttDown(*) {
    global held
    if held          ; typematic repeat while the key is down
        return
    held := true
    Post("/key/ptt-down")
    SetTimer(WatchRelease, 100)
}

; A lost key-up event would leave held set, and every later press would read
; as a repeat. This releases the key once it is physically up.
WatchRelease() {
    if held && !GetKeyState(PTT_KEY, "P")
        PttUp()
}

PttUp(*) {
    global held
    SetTimer(WatchRelease, 0)
    if !held
        return
    held := false
    ; A tap opens the dock. Windows only lets the app that just got
    ; input take focus, which is this script, so it hands focus over.
    if InStr(Post("/key/ptt-up"), '"focus":true') {
        Sleep(60)
        DetectHiddenWindows(false)
        if WinExist("Butler ahk_exe electron.exe")
            try WinActivate()
    }
}

try {
    Hotkey("*" PTT_KEY, PttDown)
} catch {
    TrayTip(PTT_KEY " cannot be bound; using Pause", "Butler", 2)
    PTT_KEY := "Pause"
    Hotkey("*" PTT_KEY, PttDown)
}
Hotkey("*" PTT_KEY " up", PttUp)
