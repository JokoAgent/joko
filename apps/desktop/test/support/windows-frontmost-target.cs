using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal sealed class FrontmostTargetForm : Form
{
    internal readonly FrontmostTargetTextBox Input = new FrontmostTargetTextBox();
    internal int ReturnDown;
    internal int ReturnUp;
    internal int Wheels;
    internal int WheelDelta;

    internal FrontmostTargetForm(string title, int left)
    {
        Text = title;
        StartPosition = FormStartPosition.Manual;
        SetBounds(left, 80, 320, 170);
        Input.Multiline = true;
        Input.Dock = DockStyle.Fill;
        Controls.Add(Input);
        ActiveControl = Input;
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x0100 && message.WParam.ToInt64() == 13) ReturnDown++;
        if (message.Msg == 0x0101 && message.WParam.ToInt64() == 13) ReturnUp++;
        if (message.Msg == 0x020A)
        {
            Wheels++;
            WheelDelta += unchecked((short)((message.WParam.ToInt64() >> 16) & 0xffff));
        }
        base.WndProc(ref message);
    }

    internal string Snapshot()
    {
        return "{\"nativeId\":\"" + Handle.ToInt64().ToString(CultureInfo.InvariantCulture)
            + "\",\"returnDown\":" + ReturnDown + ",\"returnUp\":" + ReturnUp
            + ",\"wheels\":" + Wheels + ",\"wheelDelta\":" + WheelDelta
            + ",\"pastes\":" + Input.Pastes + ",\"pasteMatches\":"
            + (Input.Text == FrontmostTargetContext.PasteSentinel ? "true" : "false")
            + ",\"focused\":" + (Input.Focused ? "true" : "false")
            + ",\"textLength\":" + Input.TextLength + "}";
    }
}

internal sealed class FrontmostTargetTextBox : TextBox
{
    internal int Pastes;

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == 0x0302) Pastes++;
        base.WndProc(ref message);
    }
}

internal sealed class FrontmostTargetContext : ApplicationContext
{
    internal const string PasteSentinel = "Joko native foreground smoke";
    private readonly FrontmostTargetForm first = new FrontmostTargetForm("Joko native input target A", 80);
    private readonly FrontmostTargetForm second = new FrontmostTargetForm("Joko native input target B", 430);
    private readonly System.Windows.Forms.Timer expiry = new System.Windows.Forms.Timer();
    private IDataObject originalClipboard;
    private bool clipboardPrepared;
    private bool exiting;

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(uint processId);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint source, uint target, bool attach);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    internal FrontmostTargetContext()
    {
        first.FormClosed += delegate { ExitThread(); };
        expiry.Interval = 40000;
        expiry.Tick += delegate { ExitThread(); };
        second.Show();
        first.Show();
        first.BeginInvoke((MethodInvoker)delegate
        {
            FocusTarget(first);
            Reply("ready");
            expiry.Start();
            Thread reader = new Thread(ReadCommands);
            reader.IsBackground = true;
            reader.Start();
        });
    }

    private void ReadCommands()
    {
        // The protocol admits only five exact JSON records, each shorter than 64 characters.
        // Read bounded characters so a malformed parent cannot retain an unbounded line.
        for (int request = 0; request < 100; request++)
        {
            string line = ReadBoundedLine();
            if (line == null) break;
            try
            {
                first.Invoke((MethodInvoker)delegate { ApplyCommand(line); });
            }
            catch { return; }
            if (line == "{\"command\":\"exit\"}") return;
        }
        try { first.BeginInvoke((MethodInvoker)delegate { ExitThread(); }); }
        catch { }
    }

    private static string ReadBoundedLine()
    {
        char[] characters = new char[64];
        int length = 0;
        for (;;)
        {
            int value = Console.In.Read();
            if (value < 0) return null;
            if (value == '\n') return new string(characters, 0, length);
            if (value == '\r') continue;
            if (length == characters.Length) return null;
            characters[length++] = (char)value;
        }
    }

    private void ApplyCommand(string line)
    {
        if (exiting) return;
        if (line == "{\"command\":\"focus-first\"}") FocusTarget(first);
        else if (line == "{\"command\":\"focus-second\"}") FocusTarget(second);
        else if (line == "{\"command\":\"clipboard\"}") PrepareClipboard();
        else if (line == "{\"command\":\"state\"}") { }
        else if (line == "{\"command\":\"exit\"}")
        {
            RestoreClipboard();
            Reply("closed");
            ExitThread();
            return;
        }
        else { ExitThread(); return; }
        Reply("state");
    }

    private static void FocusTarget(FrontmostTargetForm form)
    {
        uint foregroundProcess;
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out foregroundProcess);
        uint ownThread = GetCurrentThreadId();
        bool attached = false;
        try
        {
            if (foregroundThread != 0 && foregroundThread != ownThread)
                attached = AttachThreadInput(ownThread, foregroundThread, true);
            form.Activate();
            form.Input.Focus();
            SetForegroundWindow(form.Handle);
        }
        finally
        {
            if (attached) AttachThreadInput(ownThread, foregroundThread, false);
        }
        // The production native helper performs one fixed paste in its owning process.
        // Only the controlled foreground process may grant it activation permission.
        if (GetForegroundWindow() == form.Handle) AllowSetForegroundWindow(unchecked((uint)-1));
    }

    private void PrepareClipboard()
    {
        if (clipboardPrepared) return;
        // Existing clipboard data stays only in this STA process and never enters the protocol.
        originalClipboard = Clipboard.GetDataObject();
        Clipboard.SetText(PasteSentinel);
        clipboardPrepared = true;
    }

    private void RestoreClipboard()
    {
        if (!clipboardPrepared) return;
        try
        {
            // Do not replace clipboard data written by the user during the journey.
            if (Clipboard.ContainsText() && Clipboard.GetText() == PasteSentinel)
            {
                if (originalClipboard == null) Clipboard.Clear();
                else Clipboard.SetDataObject(originalClipboard, true);
            }
        }
        catch { }
        clipboardPrepared = false;
        originalClipboard = null;
    }

    private void Reply(string kind)
    {
        Console.Out.WriteLine("{\"event\":\"" + kind + "\",\"pid\":"
            + Process.GetCurrentProcess().Id + ",\"foreground\":\""
            + GetForegroundWindow().ToInt64().ToString(CultureInfo.InvariantCulture)
            + "\",\"clipboardPrepared\":" + (clipboardPrepared ? "true" : "false")
            + ",\"first\":" + first.Snapshot() + ",\"second\":" + second.Snapshot() + "}");
        Console.Out.Flush();
    }

    protected override void ExitThreadCore()
    {
        if (exiting) return;
        exiting = true;
        expiry.Stop();
        RestoreClipboard();
        second.Close();
        first.Close();
        base.ExitThreadCore();
    }
}

internal static class FrontmostTargetProgram
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (FrontmostTargetContext context = new FrontmostTargetContext()) Application.Run(context);
    }
}
