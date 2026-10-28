// Native half of winhost.ps1: mouse, keyboard, screenshots and windows through
// user32. Compiled once per session by Add-Type, so keep it to the framework
// assemblies Windows PowerShell 5.1 already has (System.Drawing, WinForms).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class ButlerHost
{
    // ── interop ─────────────────────────────────────────────────────────────
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmFrame(IntPtr hWnd, int attr, out RECT value, int size);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010;
    const uint MDOWN = 0x0020, MUP = 0x0040, XDOWN = 0x0080, XUP = 0x0100, WHEEL = 0x0800, HWHEEL = 0x1000;
    const uint KEYUP = 0x0002, EXTENDED = 0x0001, UNICODE = 0x0004;

    public static void Init()
    {
        // Per-monitor v2: every coordinate here is a physical pixel on every display.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        timeBeginPeriod(1);
    }

    static void Send(params INPUT[] inputs)
    {
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static INPUT Mouse(uint flags, int dx = 0, int dy = 0, uint data = 0)
    {
        var i = new INPUT { type = INPUT_MOUSE };
        i.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags };
        return i;
    }

    static INPUT Key(ushort vk, bool up)
    {
        var i = new INPUT { type = INPUT_KEYBOARD };
        uint flags = up ? KEYUP : 0;
        if (IsExtended(vk)) flags |= EXTENDED;
        i.u.ki = new KEYBDINPUT { wVk = vk, dwFlags = flags };
        return i;
    }

    static INPUT Unicode(char c, bool up)
    {
        var i = new INPUT { type = INPUT_KEYBOARD };
        i.u.ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = UNICODE | (up ? KEYUP : 0) };
        return i;
    }

    // ── mouse ───────────────────────────────────────────────────────────────
    public static int[] CursorPos()
    {
        POINT p; GetCursorPos(out p);
        return new[] { p.X, p.Y };
    }

    public static void MoveAbs(int x, int y) { SetCursorPos(x, y); }

    // Relative moves are what games read through raw input; SetCursorPos alone
    // moves the pointer without a game noticing.
    public static void MoveRel(int dx, int dy) { Send(Mouse(MOVE, dx, dy)); }

    // Flat triplets: dx, dy, delay ms. Runs a whole human-looking path in one call.
    public static void PlayPath(int[] flat)
    {
        for (int i = 0; i + 2 < flat.Length; i += 3)
        {
            if (flat[i] != 0 || flat[i + 1] != 0) MoveRel(flat[i], flat[i + 1]);
            if (flat[i + 2] > 0) Thread.Sleep(flat[i + 2]);
        }
    }

    public static void Button(string button, bool up)
    {
        switch ((button ?? "left").ToLowerInvariant())
        {
            case "right": Send(Mouse(up ? RUP : RDOWN)); break;
            case "middle": case "wheel": Send(Mouse(up ? MUP : MDOWN)); break;
            case "back": Send(Mouse(up ? XUP : XDOWN, 0, 0, 1)); break;
            case "forward": Send(Mouse(up ? XUP : XDOWN, 0, 0, 2)); break;
            default: Send(Mouse(up ? LUP : LDOWN)); break;
        }
    }

    public static void Click(string button, int count)
    {
        for (int n = 0; n < Math.Max(1, count); n++)
        {
            Button(button, false);
            Thread.Sleep(12);
            Button(button, true);
            if (n + 1 < count) Thread.Sleep(60);
        }
    }

    // Positive dy scrolls down, matching the computer-use convention.
    public static void Scroll(int dx, int dy)
    {
        if (dy != 0) Send(Mouse(WHEEL, 0, 0, unchecked((uint)(-dy * 120))));
        if (dx != 0) Send(Mouse(HWHEEL, 0, 0, unchecked((uint)(dx * 120))));
    }

    // ── keyboard ────────────────────────────────────────────────────────────
    static readonly Dictionary<string, ushort> Names = BuildNames();

    static Dictionary<string, ushort> BuildNames()
    {
        var d = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
        {
            {"ctrl",0x11},{"control",0x11},{"shift",0x10},{"alt",0x12},{"menu",0x12},{"option",0x12},
            {"win",0x5B},{"windows",0x5B},{"meta",0x5B},{"super",0x5B},{"cmd",0x5B},{"command",0x5B},
            {"enter",0x0D},{"return",0x0D},{"esc",0x1B},{"escape",0x1B},{"tab",0x09},{"space",0x20},
            {"backspace",0x08},{"delete",0x2E},{"del",0x2E},{"insert",0x2D},{"home",0x24},{"end",0x23},
            {"pageup",0x21},{"pgup",0x21},{"pagedown",0x22},{"pgdn",0x22},
            {"left",0x25},{"up",0x26},{"right",0x27},{"down",0x28},
            {"arrowleft",0x25},{"arrowup",0x26},{"arrowright",0x27},{"arrowdown",0x28},
            {"capslock",0x14},{"pause",0x13},{"scrolllock",0x91},{"numlock",0x90},{"printscreen",0x2C},
            {"volume_mute",0xAD},{"volume_down",0xAE},{"volume_up",0xAF},
            {"media_next",0xB0},{"media_prev",0xB1},{"media_stop",0xB2},{"media_play_pause",0xB3},
            {";",0xBA},{"=",0xBB},{",",0xBC},{"-",0xBD},{".",0xBE},{"/",0xBF},{"`",0xC0},
            {"[",0xDB},{"\\",0xDC},{"]",0xDD},{"'",0xDE},{"plus",0xBB},{"minus",0xBD},
        };
        for (int f = 1; f <= 24; f++) d["f" + f] = (ushort)(0x6F + f);
        for (char c = 'a'; c <= 'z'; c++) d[c.ToString()] = (ushort)char.ToUpperInvariant(c);
        for (char c = '0'; c <= '9'; c++) d[c.ToString()] = (ushort)c;
        return d;
    }

    static bool IsExtended(ushort vk)
    {
        return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C
            || vk == 0x90 || vk == 0x2C || (vk >= 0xAD && vk <= 0xB3);
    }

    public static ushort Vk(string name)
    {
        ushort vk;
        if (Names.TryGetValue(name.Trim(), out vk)) return vk;
        throw new ArgumentException("unknown key: " + name);
    }

    // "ctrl+shift+t" or ["CTRL","L"]: modifiers down in order, released in reverse.
    public static void Combo(string[] keys)
    {
        var vks = new List<ushort>();
        foreach (var k in keys) if (!string.IsNullOrWhiteSpace(k)) vks.Add(Vk(k));
        var seq = new List<INPUT>();
        foreach (var vk in vks) seq.Add(Key(vk, false));
        for (int i = vks.Count - 1; i >= 0; i--) seq.Add(Key(vks[i], true));
        Send(seq.ToArray());
    }

    public static void KeyState(string name, bool up) { Send(Key(Vk(name), up)); }

    public static void TypeText(string text)
    {
        var batch = new List<INPUT>();
        foreach (char c in text ?? "")
        {
            if (c == '\r') continue;
            if (c == '\n') { batch.Add(Key(0x0D, false)); batch.Add(Key(0x0D, true)); }
            else { batch.Add(Unicode(c, false)); batch.Add(Unicode(c, true)); }
            // Chunks with a breath between them: some apps drop a single huge burst.
            if (batch.Count >= 40) { Send(batch.ToArray()); batch.Clear(); Thread.Sleep(8); }
        }
        if (batch.Count > 0) Send(batch.ToArray());
    }

    // ── screen ──────────────────────────────────────────────────────────────
    public static object[] Monitors()
    {
        var list = new List<object>();
        foreach (var s in Screen.AllScreens)
            list.Add(new Dictionary<string, object> {
                {"name", s.DeviceName}, {"primary", s.Primary},
                {"x", s.Bounds.X}, {"y", s.Bounds.Y}, {"w", s.Bounds.Width}, {"h", s.Bounds.Height},
            });
        return list.ToArray();
    }

    // Captures one monitor (primary by default), downscaled so the long edge fits
    // maxEdge. Returns origin and scale so callers can map image pixels back to
    // screen pixels: screen = origin + image / scale.
    public static Dictionary<string, object> Screenshot(int monitor, int maxEdge, string format)
    {
        Screen target = Screen.PrimaryScreen;
        if (monitor >= 0 && monitor < Screen.AllScreens.Length) target = Screen.AllScreens[monitor];
        return Capture(target.Bounds, maxEdge, format);
    }

    // Any rectangle of the desktop, e.g. the focused window.
    public static Dictionary<string, object> ScreenshotRect(int x, int y, int w, int h, int maxEdge, string format)
    {
        var r = Rectangle.Intersect(new Rectangle(x, y, Math.Max(1, w), Math.Max(1, h)), SystemInformation.VirtualScreen);
        if (r.Width < 1 || r.Height < 1) throw new ArgumentException("rectangle is off screen");
        return Capture(r, maxEdge, format);
    }

    static Dictionary<string, object> Capture(Rectangle b, int maxEdge, string format)
    {
        double scale = 1.0;
        int longEdge = Math.Max(b.Width, b.Height);
        if (maxEdge > 0 && longEdge > maxEdge) scale = (double)maxEdge / longEdge;
        int w = Math.Max(1, (int)Math.Round(b.Width * scale)), h = Math.Max(1, (int)Math.Round(b.Height * scale));

        using (var full = new Bitmap(b.Width, b.Height, PixelFormat.Format24bppRgb))
        {
            using (var g = Graphics.FromImage(full)) g.CopyFromScreen(b.X, b.Y, 0, 0, b.Size);
            using (var outBmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(outBmp))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    g.DrawImage(full, 0, 0, w, h);
                }
                using (var ms = new MemoryStream())
                {
                    bool jpeg = string.Equals(format, "jpeg", StringComparison.OrdinalIgnoreCase);
                    outBmp.Save(ms, jpeg ? ImageFormat.Jpeg : ImageFormat.Png);
                    return new Dictionary<string, object> {
                        {"w", w}, {"h", h}, {"x", b.X}, {"y", b.Y}, {"scale", scale},
                        {"mime", jpeg ? "image/jpeg" : "image/png"},
                        {"b64", Convert.ToBase64String(ms.ToArray())},
                    };
                }
            }
        }
    }

    // ── windows ─────────────────────────────────────────────────────────────
    static bool Cloaked(IntPtr h)
    {
        int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0;
    }

    static string Title(IntPtr h)
    {
        int n = GetWindowTextLength(h);
        if (n <= 0) return "";
        var sb = new StringBuilder(n + 1);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static string ProcName(IntPtr h)
    {
        uint pid; GetWindowThreadProcessId(h, out pid);
        try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
    }

    static Dictionary<string, object> Describe(IntPtr h)
    {
        RECT r; GetWindowRect(h, out r);
        return new Dictionary<string, object> {
            {"hwnd", h.ToInt64()}, {"title", Title(h)}, {"process", ProcName(h)},
            {"minimized", IsIconic(h)}, {"x", r.Left}, {"y", r.Top},
            {"w", r.Right - r.Left}, {"h", r.Bottom - r.Top},
        };
    }

    // Top-level, visible, titled, uncloaked, unowned windows in z-order: what alt-tab shows.
    public static object[] Windows()
    {
        var list = new List<object>();
        EnumWindows((h, l) =>
        {
            if (IsWindowVisible(h) && GetWindowTextLength(h) > 0 && !Cloaked(h) && GetWindow(h, 4) == IntPtr.Zero)
                list.Add(Describe(h));
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }

    public static Dictionary<string, object> Foreground()
    {
        var h = GetForegroundWindow();
        return h == IntPtr.Zero ? null : Describe(h);
    }

    // Windows refuses SetForegroundWindow from a background process unless the
    // caller just produced input; an Alt tap counts and does nothing visible.
    public static bool Focus(long hwnd)
    {
        var h = new IntPtr(hwnd);
        if (IsIconic(h)) ShowWindow(h, 9);
        Send(Key(0x12, false), Key(0x12, true));
        return SetForegroundWindow(h);
    }

    public static void Show(long hwnd, string how)
    {
        var h = new IntPtr(hwnd);
        switch (how)
        {
            case "minimize": ShowWindow(h, 6); break;
            case "maximize": ShowWindow(h, 3); break;
            case "restore": ShowWindow(h, 9); break;
            case "close": PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); break;
            default: throw new ArgumentException("unknown window action: " + how);
        }
    }

    // Fills a monitor's work area: "side" is the first monitor that is not the
    // primary (the primary when there is only one). Sized by the visible frame,
    // not the invisible resize border, so the window meets the screen edges.
    // Placed twice: a move across a DPI change lets the app resize itself.
    public static bool Fill(long hwnd, string which)
    {
        var h = new IntPtr(hwnd);
        Screen target = Screen.PrimaryScreen;
        if (which == "side") foreach (var s in Screen.AllScreens) if (!s.Primary) { target = s; break; }
        if (IsIconic(h) || IsZoomed(h)) ShowWindow(h, 9);
        var a = target.WorkingArea;
        bool ok = false;
        for (int i = 0; i < 2; i++)
        {
            RECT w, f; GetWindowRect(h, out w);
            int dl = 0, dt = 0, dr = 0, db = 0;
            if (DwmFrame(h, 9, out f, Marshal.SizeOf(typeof(RECT))) == 0)
            { dl = f.Left - w.Left; dt = f.Top - w.Top; dr = w.Right - f.Right; db = w.Bottom - f.Bottom; }
            ok = SetWindowPos(h, IntPtr.Zero, a.X - dl, a.Y - dt, a.Width + dl + dr, a.Height + dt + db, 0x0014);
        }
        return ok;
    }
}
