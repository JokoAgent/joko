use serde_json::Value;
use std::{
    collections::HashSet,
    io::{self, BufRead, Read, Write},
    sync::mpsc,
    time::Duration,
};
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::UI::{HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*};

mod desktop;
mod selection;

static FAILED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn send(input: INPUT) -> bool {
    let ok = unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) == 1 };
    if !ok && !FAILED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        let status = unsafe { GetLastError() };
        println!("error send_input {status}");
        io::stdout().flush().ok();
    }
    ok
}

fn key(code: u16, down: bool, unicode: bool) -> bool {
    let extended = [0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e]
        .contains(&code);
    send(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: if unicode { 0 } else { code },
                wScan: if unicode { code } else { 0 },
                dwFlags: (if down { 0 } else { KEYEVENTF_KEYUP })
                    | (if unicode { KEYEVENTF_UNICODE } else if extended { KEYEVENTF_EXTENDEDKEY } else { 0 }),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    })
}

fn mouse(flags: u32, dx: i32, dy: i32, data: u32) -> bool {
    send(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    })
}

fn button(value: u64, down: bool) -> bool {
    mouse(match (value, down) {
        (0, true) => MOUSEEVENTF_LEFTDOWN,
        (0, false) => MOUSEEVENTF_LEFTUP,
        (1, true) => MOUSEEVENTF_MIDDLEDOWN,
        (1, false) => MOUSEEVENTF_MIDDLEUP,
        (2, true) => MOUSEEVENTF_RIGHTDOWN,
        _ => MOUSEEVENTF_RIGHTUP,
    }, 0, 0, 0)
}

fn code(value: &str) -> Option<u16> {
    if value.len() == 4 && value.starts_with("Key") && value.as_bytes()[3].is_ascii_uppercase() {
        return Some(value.as_bytes()[3] as u16);
    }
    if value.len() == 6 && value.starts_with("Digit") && value.as_bytes()[5].is_ascii_digit() {
        return Some(value.as_bytes()[5] as u16);
    }
    if let Some(number) = value.strip_prefix('F').and_then(|suffix| suffix.parse::<u16>().ok()) {
        if (1..=12).contains(&number) { return Some(0x6f + number); }
    }
    Some(match value {
        "Enter" => 13, "Escape" => 27, "Tab" => 9, "Space" => 32, "Backspace" => 8,
        "Delete" => 46, "Insert" => 45, "Home" => 36, "End" => 35, "PageUp" => 33,
        "PageDown" => 34, "ArrowUp" => 38, "ArrowDown" => 40, "ArrowLeft" => 37,
        "ArrowRight" => 39, "ShiftLeft" => 0xa0, "ControlLeft" => 0xa2,
        "AltLeft" => 0xa4, "MetaLeft" => 0x5b, "Minus" => 0xbd, "Equal" => 0xbb,
        "BracketLeft" => 0xdb, "BracketRight" => 0xdd, "Backslash" => 0xdc,
        "Semicolon" => 0xba, "Quote" => 0xde, "Backquote" => 0xc0, "Comma" => 0xbc,
        "Period" => 0xbe, "Slash" => 0xbf,
        _ => return None,
    })
}

fn release(keys: &mut HashSet<u16>, buttons: &mut HashSet<u64>) {
    for value in keys.clone() {
        if key(value, false, false) { keys.remove(&value); }
    }
    for value in buttons.clone() {
        if button(value, false) { buttons.remove(&value); }
    }
}

fn desktop_ready() -> bool {
    match desktop::require_unlocked() {
        Ok(()) => true,
        Err(desktop::DesktopStatus::Locked) => {
            println!("locked"); io::stdout().flush().ok(); false
        }
        Err(desktop::DesktopStatus::Error(status)) => {
            println!("error input_desktop {status}"); io::stdout().flush().ok(); false
        }
    }
}

fn main() {
    if matches!(
        std::env::args().nth(1).as_deref(),
        Some("--clipboard-selection" | "--clipboard-content-selection")
    ) {
        let portable = std::env::args().nth(1).as_deref()
            == Some("--clipboard-content-selection");
        match selection::read(portable) {
            Ok(text) => println!("{}", serde_json::json!({ "text": text })),
            Err(_) => std::process::exit(2),
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--clipboard-version") {
        if desktop::require_unlocked().is_err() {
            std::process::exit(2);
        }
        let version = unsafe {
            windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber()
        };
        println!("{version}");
        return;
    }
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }
    if !desktop_ready() { return; }

    let (sender, receiver) = mpsc::sync_channel(64);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let mut line = Vec::new();
            match input.by_ref().take(32_769).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > 32_768 || line.last() != Some(&b'\n') => break,
                Ok(_) if sender.send(line).is_err() => break,
                Ok(_) => (),
            }
        }
    });

    let mut keys = HashSet::new();
    let mut buttons = HashSet::new();
    println!("ready");
    io::stdout().flush().ok();
    'input: loop {
        let line = match receiver.recv_timeout(Duration::from_secs(5)) {
            Ok(line) => line,
            Err(_) => break,
        };
        if !desktop_ready() { break; }
        let events: Vec<Value> = match serde_json::from_slice::<Vec<Value>>(&line) {
            Ok(events) if events.len() <= 64 => events,
            _ => break,
        };
        for event in events {
            if desktop::require_unlocked().is_err() { break 'input; }
            if FAILED.load(std::sync::atomic::Ordering::SeqCst) { break 'input; }
            match event["kind"].as_str().unwrap_or("") {
                "release" => release(&mut keys, &mut buttons),
                kind @ ("move" | "button") => {
                    if let (Some(x), Some(y)) = (event["x"].as_f64(), event["y"].as_f64()) {
                        if x.is_finite() && y.is_finite() {
                            unsafe {
                                let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
                                let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
                                let width = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2);
                                let height = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2);
                                mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                                    (((x - left as f64) * 65535.0) / (width - 1) as f64) as i32,
                                    (((y - top as f64) * 65535.0) / (height - 1) as f64) as i32, 0);
                            }
                        }
                    }
                    if kind == "button" {
                        if let (Some(value), Some(down)) = (event["button"].as_u64(), event["down"].as_bool()) {
                            if value <= 2 {
                                if down { buttons.insert(value); }
                                if button(value, down) && !down { buttons.remove(&value); }
                            }
                        }
                    }
                }
                "key" => {
                    if let (Some(value), Some(down)) =
                        (event["code"].as_str().and_then(code), event["down"].as_bool()) {
                        if down { keys.insert(value); }
                        if key(value, down, false) && !down { keys.remove(&value); }
                    }
                }
                "text" => {
                    if let Some(text) = event["text"].as_str() {
                        for value in text.encode_utf16().take(4_096) {
                            if desktop::require_unlocked().is_err() { break 'input; }
                            key(value, true, true); key(value, false, true);
                        }
                    }
                }
                "scroll" => {
                    let dy = event["dy"].as_f64().unwrap_or(0.0).clamp(-2_000.0, 2_000.0) as i32;
                    let dx = event["dx"].as_f64().unwrap_or(0.0).clamp(-2_000.0, 2_000.0) as i32;
                    if dy != 0 { mouse(MOUSEEVENTF_WHEEL, 0, 0, (-dy) as u32); }
                    if dx != 0 { mouse(MOUSEEVENTF_HWHEEL, 0, 0, dx as u32); }
                }
                _ => (),
            }
        }
    }
    release(&mut keys, &mut buttons);
}
