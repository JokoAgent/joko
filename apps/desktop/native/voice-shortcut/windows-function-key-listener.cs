using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

internal static class JokoFunctionKeyListener
{
    private const int WhKeyboardLl = 13;
    private const int HcAction = 0;
    private const int WmKeyDown = 0x0100;
    private const int WmKeyUp = 0x0101;
    private const int WmSysKeyDown = 0x0104;
    private const int WmSysKeyUp = 0x0105;
    private const int VkF1 = 0x70;

    private static readonly int[] PhysicalModifierKeys =
    {
        0xA0, // VK_LSHIFT
        0xA1, // VK_RSHIFT
        0xA2, // VK_LCONTROL
        0xA3, // VK_RCONTROL
        0xA4, // VK_LMENU
        0xA5, // VK_RMENU
        0x5B, // VK_LWIN
        0x5C  // VK_RWIN
    };

    private static readonly LowLevelKeyboardProc HookCallback = HandleKeyboardEvent;
    private static readonly HashSet<int> ModifiersDown = new HashSet<int>();
    private static readonly HashSet<int> OtherKeysDown = new HashSet<int>();
    private static TargetPress targetPress = TargetPress.Idle;
    private static int targetVirtualKey;

    private enum TargetPress
    {
        Idle,
        Rejected,
        Active,
        Canceled
    }

    public static int Main(string[] args)
    {
        int functionNumber;
        if (args.Length != 1 || !TryParseFunctionKey(args[0], out functionNumber))
        {
            EmitError("Expected exactly one argument from F1 through F24.");
            return 2;
        }

        targetVirtualKey = VkF1 + functionNumber - 1;
        SeedPhysicalState();
        targetPress = IsKeyDown(targetVirtualKey) ? TargetPress.Rejected : TargetPress.Idle;

        IntPtr module = GetModuleHandle(null);
        IntPtr hook = SetWindowsHookEx(WhKeyboardLl, HookCallback, module, 0);
        if (hook == IntPtr.Zero)
        {
            EmitError("Could not install the Windows keyboard listener.");
            return 3;
        }

        EmitLine("{\"type\":\"ready\"}");
        Message message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
        {
        }
        UnhookWindowsHookEx(hook);
        return 0;
    }

    private static IntPtr HandleKeyboardEvent(int code, IntPtr parameter, IntPtr data)
    {
        if (code != HcAction)
        {
            return CallNextHookEx(IntPtr.Zero, code, parameter, data);
        }

        KeyboardEvent keyboardEvent = (KeyboardEvent)Marshal.PtrToStructure(data, typeof(KeyboardEvent));
        int virtualKey = unchecked((int)keyboardEvent.VirtualKey);
        int message = unchecked((int)parameter.ToInt64());
        bool keyDown = message == WmKeyDown || message == WmSysKeyDown;
        bool keyUp = message == WmKeyUp || message == WmSysKeyUp;

        if (virtualKey != targetVirtualKey)
        {
            TrackForeignKey(virtualKey, keyDown, keyUp);
            if (keyDown && targetPress == TargetPress.Active)
            {
                targetPress = TargetPress.Canceled;
                EmitLine("{\"type\":\"canceled\"}");
            }
            return CallNextHookEx(IntPtr.Zero, code, parameter, data);
        }

        if (keyDown)
        {
            if (targetPress == TargetPress.Idle)
            {
                if (ModifiersDown.Count == 0 && OtherKeysDown.Count == 0)
                {
                    targetPress = TargetPress.Active;
                    EmitPressed(true);
                    return new IntPtr(1);
                }
                targetPress = TargetPress.Rejected;
                return CallNextHookEx(IntPtr.Zero, code, parameter, data);
            }
            return targetPress == TargetPress.Active || targetPress == TargetPress.Canceled
                ? new IntPtr(1)
                : CallNextHookEx(IntPtr.Zero, code, parameter, data);
        }

        if (keyUp)
        {
            TargetPress previous = targetPress;
            targetPress = TargetPress.Idle;
            if (previous == TargetPress.Active || previous == TargetPress.Canceled)
            {
                EmitPressed(false);
                return new IntPtr(1);
            }
            if (previous == TargetPress.Rejected)
            {
                EmitPressed(false);
            }
        }

        return CallNextHookEx(IntPtr.Zero, code, parameter, data);
    }

    private static void SeedPhysicalState()
    {
        ModifiersDown.Clear();
        OtherKeysDown.Clear();
        foreach (int virtualKey in PhysicalModifierKeys)
        {
            if (IsKeyDown(virtualKey))
            {
                ModifiersDown.Add(virtualKey);
            }
        }
        for (int virtualKey = 0; virtualKey < 256; virtualKey += 1)
        {
            if (!IsKeyDown(virtualKey) || IsMouseButton(virtualKey) || IsModifier(virtualKey) || virtualKey == targetVirtualKey)
            {
                continue;
            }
            OtherKeysDown.Add(virtualKey);
        }
    }

    private static void TrackForeignKey(int virtualKey, bool keyDown, bool keyUp)
    {
        if (IsMouseButton(virtualKey))
        {
            return;
        }
        HashSet<int> set = IsModifier(virtualKey) ? ModifiersDown : OtherKeysDown;
        if (keyDown)
        {
            set.Add(virtualKey);
        }
        else if (keyUp)
        {
            set.Remove(virtualKey);
        }
    }

    private static bool TryParseFunctionKey(string value, out int number)
    {
        number = 0;
        return value.Length >= 2
            && value[0] == 'F'
            && Int32.TryParse(value.Substring(1), out number)
            && number >= 1
            && number <= 24;
    }

    private static bool IsModifier(int virtualKey)
    {
        return virtualKey == 0x10 || virtualKey == 0x11 || virtualKey == 0x12
            || (virtualKey >= 0xA0 && virtualKey <= 0xA5)
            || virtualKey == 0x5B || virtualKey == 0x5C;
    }

    private static bool IsMouseButton(int virtualKey)
    {
        return virtualKey >= 0x01 && virtualKey <= 0x06;
    }

    private static bool IsKeyDown(int virtualKey)
    {
        return GetAsyncKeyState(virtualKey) < 0;
    }

    private static void EmitPressed(bool pressed)
    {
        EmitLine(pressed
            ? "{\"type\":\"pressed\",\"pressed\":true}"
            : "{\"type\":\"pressed\",\"pressed\":false}");
    }

    private static void EmitError(string message)
    {
        string escaped = message.Replace("\\", "\\\\").Replace("\"", "\\\"");
        EmitLine("{\"type\":\"error\",\"message\":\"" + escaped + "\"}");
    }

    private static void EmitLine(string value)
    {
        Console.Out.WriteLine(value);
        Console.Out.Flush();
    }

    private delegate IntPtr LowLevelKeyboardProc(int code, IntPtr parameter, IntPtr data);

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardEvent
    {
        public uint VirtualKey;
        public uint ScanCode;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr Window;
        public uint Value;
        public IntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public Point Location;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(
        int hook,
        LowLevelKeyboardProc callback,
        IntPtr module,
        uint threadId);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr parameter, IntPtr data);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out Message message, IntPtr window, uint minimum, uint maximum);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string moduleName);
}
