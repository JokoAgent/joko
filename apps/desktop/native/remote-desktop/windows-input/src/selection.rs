use windows::{
    core::Interface,
    Win32::{System::Com::*, UI::Accessibility::*},
};

use crate::desktop;

pub fn read(portable: bool) -> windows::core::Result<String> {
    unsafe {
        require_unlocked()?;
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        struct Com;
        impl Drop for Com {
            fn drop(&mut self) {
                unsafe { CoUninitialize(); }
            }
        }
        let _com = Com;
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let element = automation.GetFocusedElement()?;
        if element.CurrentIsPassword()?.as_bool() {
            return Err(windows::core::Error::from_win32());
        }
        let text = match element.GetCurrentPattern(UIA_TextPatternId) {
            Ok(pattern) => {
                let pattern: IUIAutomationTextPattern = pattern.cast()?;
                let selection = pattern.GetSelection()?;
                // Disjoint selections have application-specific ordering and
                // are not one portable clipboard item.
                let count = selection.Length()?;
                if !(0..=1).contains(&count) {
                    return Err(windows::core::Error::from_win32());
                }
                if count == 0 {
                    String::new()
                } else {
                    selection.GetElement(0)?.GetText(16_385)?.to_string()
                }
            }
            // TextPattern being unsupported is not by itself proof that the
            // focused element is non-text: custom/protected editors may omit
            // the pattern. Only known non-text control types may opt into the
            // rich system-clipboard fallback; everything else fails closed.
            Err(error) if portable && error.code().0 as u32 == UIA_E_NOTSUPPORTED => {
                if !confirmed_non_text_control_type(element.CurrentControlType()?) {
                    return Err(error);
                }
                String::new()
            }
            Err(error) => return Err(error),
        };
        if text.encode_utf16().count() > 16_384
            || !automation
                .CompareElements(&element, &automation.GetFocusedElement()?)?
                .as_bool()
        {
            return Err(windows::core::Error::from_win32());
        }
        require_unlocked()?;
        if element.CurrentIsPassword()?.as_bool() {
            return Err(windows::core::Error::from_win32());
        }
        Ok(text)
    }
}

fn confirmed_non_text_control_type(control_type: UIA_CONTROLTYPE_ID) -> bool {
    [
        UIA_ButtonControlTypeId,
        UIA_ImageControlTypeId,
        UIA_ListControlTypeId,
        UIA_TableControlTypeId,
        UIA_TreeControlTypeId,
    ]
    .contains(&control_type)
}

fn require_unlocked() -> windows::core::Result<()> {
    desktop::require_unlocked().map_err(|_| windows::core::Error::from_win32())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_non_text_controls_confirm_an_empty_selection() {
        for control_type in [
            UIA_ButtonControlTypeId,
            UIA_ImageControlTypeId,
            UIA_ListControlTypeId,
            UIA_TableControlTypeId,
            UIA_TreeControlTypeId,
        ] {
            assert!(confirmed_non_text_control_type(control_type));
        }
        for control_type in [
            UIA_EditControlTypeId,
            UIA_DocumentControlTypeId,
            UIA_CustomControlTypeId,
            UIA_ListItemControlTypeId,
            UIA_DataItemControlTypeId,
            UIA_GroupControlTypeId,
            UIA_PaneControlTypeId,
        ] {
            assert!(!confirmed_non_text_control_type(control_type));
        }
    }
}
