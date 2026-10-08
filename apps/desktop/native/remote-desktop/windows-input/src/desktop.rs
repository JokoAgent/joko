use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::System::StationsAndDesktops::*;

#[derive(Debug, PartialEq)]
pub enum DesktopStatus {
    Locked,
    Error(u32),
}

// First-batch control is deliberately restricted to the ordinary unlocked
// user desktop. No service, SYSTEM worker, or secure-desktop path is present.
pub fn require_unlocked() -> Result<(), DesktopStatus> {
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() {
            return Err(DesktopStatus::Error(GetLastError()));
        }
        let mut name = [0u16; 256];
        let mut needed = 0;
        let ok = GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            name.as_mut_ptr().cast(),
            (name.len() * 2) as u32,
            &mut needed,
        );
        let status = if ok == 0 { Some(GetLastError()) } else { None };
        CloseDesktop(desktop);
        if let Some(status) = status {
            return Err(DesktopStatus::Error(status));
        }
        let length = name.iter().position(|value| *value == 0).unwrap_or(name.len());
        if String::from_utf16_lossy(&name[..length]) != "Default" {
            return Err(DesktopStatus::Locked);
        }
        Ok(())
    }
}
