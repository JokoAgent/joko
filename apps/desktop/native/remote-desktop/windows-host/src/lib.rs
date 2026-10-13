//! Main-only Node-API transport: the OS sees the actual Joko PID opening the
//! pipe. A child process or a self-reported parent PID is never authorization.
mod capture_protocol;
mod pipe;
mod win;
use napi_derive::napi;
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use windows_sys::Win32::System::Services::*;
fn failure(_: impl std::fmt::Debug) -> napi::Error {
    napi::Error::from_reason("DESKTOP_SYSTEM_SERVICE_UNAVAILABLE")
}
#[napi]
pub struct DesktopConnection {
    pipe: Arc<Mutex<Option<pipe::Pipe>>>,
    cancel: Arc<AtomicBool>,
    response_limit: usize,
    ready: bool,
}
#[napi]
impl DesktopConnection {
    #[napi(factory)]
    pub async fn open(binary: String, init: String) -> napi::Result<Self> {
        tokio::task::spawn_blocking(move || {
            let path = PathBuf::from(binary).canonicalize().map_err(failure)?;
            let name = format!(
                "JokoRemoteDesktop-{:x}",
                Sha256::digest(path.to_string_lossy().to_lowercase().as_bytes())
            )[..35]
                .to_string();
            let mut pipe = pipe::Pipe::client(&format!(r"\\.\pipe\{}", name)).map_err(failure)?;
            let pid = pipe.server_pid().map_err(failure)?;
            let server = win::process(pid).map_err(failure)?;
            if !win::system(win::token(server.0).map_err(failure)?.0).map_err(failure)?
                || win::image(server.0)
                    .map_err(failure)?
                    .canonicalize()
                    .map_err(failure)?
                    != path
            {
                return Err(failure("identity"));
            }
            unsafe {
                let manager =
                    OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT);
                if manager.is_null() {
                    return Err(failure("scm"));
                }
                let service =
                    OpenServiceW(manager, win::wide(&name).as_ptr(), SERVICE_QUERY_STATUS);
                CloseServiceHandle(manager);
                if service.is_null() {
                    return Err(failure("service"));
                }
                let mut status: SERVICE_STATUS_PROCESS = std::mem::zeroed();
                let mut needed = 0;
                let ok = QueryServiceStatusEx(
                    service,
                    SC_STATUS_PROCESS_INFO,
                    (&mut status as *mut SERVICE_STATUS_PROCESS).cast(),
                    std::mem::size_of_val(&status) as u32,
                    &mut needed,
                );
                CloseServiceHandle(service);
                if ok == 0 || status.dwCurrentState != SERVICE_RUNNING || status.dwProcessId != pid
                {
                    return Err(failure("service identity"));
                }
            }
            if init.len() > 1023 || init.contains('\n') {
                return Err(failure("init"));
            }
            let parsed: serde_json::Value = serde_json::from_str(&init).map_err(failure)?;
            if !capture_protocol::validate_init(&parsed, false) {
                return Err(failure("init"));
            }
            let response_limit = capture_protocol::response_limit(&parsed);
            let ready = pipe.write(format!("{init}\n").as_bytes())
                .and_then(|_| pipe.line(1024))
                .is_ok_and(|receipt| receipt == b"ready\n");
            if !ready && parsed["mode"] == "probe" { return Err(failure("ready")); }
            // A failed worker handshake still has an owning instance. Main must
            // reject start when ready=false, then close/retry until retirement.
            let cancel = Arc::new(AtomicBool::new(!ready));
            // Probe owns no worker. The broker closes it after the ready receipt.
            let pipe = if parsed["mode"] == "probe" { None } else { Some(pipe) };
            Ok(Self {
                pipe: Arc::new(Mutex::new(pipe)),
                cancel,
                response_limit,
                ready,
            })
        })
        .await
        .map_err(failure)?
    }
    #[napi(getter)]
    pub fn ready(&self) -> bool { self.ready }
    #[napi]
    pub async fn request(&self, line: String) -> napi::Result<String> {
        if line.len() > 32767 || line.contains(['\n', '\r', '\0']) || self.cancel.load(Ordering::SeqCst) {
            return Err(failure("request"));
        }
        let pipe = self.pipe.clone();
        let cancel = self.cancel.clone();
        let response_limit = self.response_limit;
        tokio::task::spawn_blocking(move || {
            let mut guard = pipe.lock().map_err(failure)?;
            if cancel.load(Ordering::SeqCst) {
                return Err(failure("closing"));
            }
            let result = (|| {
                let pipe = guard.as_mut().ok_or_else(|| failure("closed"))?;
                pipe.write(format!("{line}\n").as_bytes())
                    .map_err(failure)?;
                let bytes = pipe.line(response_limit).map_err(failure)?;
                if bytes == b"closed\n" {
                    // Only this broker receipt proves that the whole job exited.
                    guard.take();
                    return Err(failure("retired"));
                }
                String::from_utf8(bytes).map_err(failure)
            })();
            // A timeout or transport failure retains ownership for close/retry.
            result
        })
        .await
        .map_err(failure)?
    }
    #[napi]
    pub async fn close(&self) -> napi::Result<()> {
        self.cancel.store(true, Ordering::SeqCst);
        let pipe = self.pipe.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = pipe.lock().map_err(failure)?;
            let Some(pipe) = guard.as_mut() else { return Ok(()); };
            // Serialize after the admitted request. Do not cancel its effect and
            // confuse I/O cancellation with worker retirement.
            pipe.retire().map_err(failure)?;
            guard.take();
            Ok(())
        }).await.map_err(failure)?
    }
}
impl Drop for DesktopConnection {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        // Process destruction is a disconnect, not a successful close receipt.
        // The service still owns and reaps its job before ending the client.
        if let Ok(mut guard) = self.pipe.try_lock() {
            if let Some(pipe) = guard.as_mut() { pipe.cancel.store(true, Ordering::SeqCst); }
            guard.take();
        }
    }
}
