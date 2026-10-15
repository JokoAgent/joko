#![cfg(windows)]
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, fs::{self, File, OpenOptions}, io::{self, BufRead, BufReader, Read, Write},
  mem, os::windows::io::{FromRawHandle, RawHandle}, path::Path, ptr,
  sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex}, thread, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::*, Security::SECURITY_ATTRIBUTES, Storage::FileSystem::*,
  System::{JobObjects::*, Pipes::CreatePipe, Threading::*}};

const MAX_LINE: usize = 262_144;
const SOURCE_DIGEST: &str = env!("JOKO_COMMAND_HOST_SOURCE_DIGEST");
struct Handle(HANDLE);
unsafe impl Send for Handle {}
impl Handle {
  fn new(raw: HANDLE) -> io::Result<Self> { if raw.is_null() || raw == INVALID_HANDLE_VALUE { Err(io::Error::last_os_error()) } else { Ok(Self(raw)) } }
  fn file(self) -> File { let raw = self.0; mem::forget(self); unsafe { File::from_raw_handle(raw as RawHandle) } }
}
impl Drop for Handle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
fn wide(text: &str) -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() }
fn invalid<T>() -> io::Result<T> { Err(io::Error::from(io::ErrorKind::InvalidData)) }
fn line(reader: &mut impl BufRead) -> io::Result<Option<Value>> {
  let mut bytes = Vec::new(); let count = reader.take((MAX_LINE + 1) as u64).read_until(b'\n', &mut bytes)?;
  if count == 0 { return Ok(None); }
  if count > MAX_LINE || bytes.last() != Some(&b'\n') { return invalid(); }
  serde_json::from_slice(&bytes).map(Some).map_err(|_| io::Error::from(io::ErrorKind::InvalidData))
}
fn exact(value: &Value, names: &[&str]) -> bool {
  value.as_object().map(|object| object.len() == names.len() && names.iter().all(|name| object.contains_key(*name))).unwrap_or(false)
}
fn text(value: &Value, maximum: usize) -> io::Result<String> {
  let value = value.as_str().ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
  if value.is_empty() || value.len() > maximum || value.contains('\0') { return invalid(); } Ok(value.to_owned())
}
fn quote(text: &str) -> String {
  let mut output = String::from("\""); let mut slashes = 0;
  for character in text.chars() {
    if character == '\\' { slashes += 1; continue; }
    if character == '"' { output.push_str(&"\\".repeat(slashes * 2 + 1)); output.push('"'); }
    else { output.push_str(&"\\".repeat(slashes)); output.push(character); }
    slashes = 0;
  }
  output.push_str(&"\\".repeat(slashes * 2)); output.push('"'); output
}
struct Request { nonce: String, executable: String, args: Vec<String>, cwd: String, environment: Vec<u16>, timeout: Duration,
  journal_directory: String, journal: Value }
fn request(value: Value) -> io::Result<Request> {
  if !exact(&value, &["protocol", "nonce", "commandId", "journalDirectory", "operationId", "helperSha256", "helperSourceDigest", "executable", "args", "cwd", "environment", "timeoutMs"]) || value["protocol"] != 1 { return invalid(); }
  let nonce = text(&value["nonce"], 128)?;
  if !nonce.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') { return invalid(); }
  let command_id = text(&value["commandId"], 128)?; let operation_id = text(&value["operationId"], 128)?;
  if ![&command_id, &operation_id].iter().all(|text| text.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')) { return invalid(); }
  let journal_directory = text(&value["journalDirectory"], 16_384)?;
  let journal_path = Path::new(&journal_directory);
  if !journal_path.is_absolute() || journal_path.file_name().and_then(|name| name.to_str()) != Some(&command_id) || !journal_path.is_dir() { return invalid(); }
  let sha = text(&value["helperSha256"], 64)?;
  if sha.len() != 64 || !sha.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) || value["helperSourceDigest"] != SOURCE_DIGEST { return invalid(); }
  let journal_bytes = fs::read(journal_path.join("request.json"))?; if journal_bytes.len() > 32_768 { return invalid(); }
  let journal: Value = serde_json::from_slice(&journal_bytes)?;
  if !exact(&journal, &["format", "commandId", "nonce", "operationId", "platform", "helperSha256", "helperSourceDigest", "directory"])
    || journal["format"] != 1 || journal["platform"] != "win32" || journal["commandId"] != command_id || journal["nonce"] != nonce || journal["operationId"] != operation_id
    || journal["helperSha256"] != sha || journal["helperSourceDigest"] != SOURCE_DIGEST || journal["directory"] != journal_directory { return invalid(); }
  let executable = text(&value["executable"], 16_384)?; let cwd = text(&value["cwd"], 16_384)?;
  if !Path::new(&executable).is_absolute() || !Path::new(&cwd).is_absolute() || !Path::new(&executable).is_file() || !Path::new(&cwd).is_dir() { return invalid(); }
  let name = Path::new(&executable).file_name().and_then(|name| name.to_str()).unwrap_or("").to_ascii_lowercase();
  let raw_args = value["args"].as_array().ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
  if raw_args.len() > 1024 { return invalid(); }
  let mut args = Vec::new();
  for raw in raw_args { let arg = raw.as_str().ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
    if arg.contains('\0') || arg.len() > 32_768 { return invalid(); } args.push(arg.to_owned()); }
  let node_host = ["electron.exe", "joko.exe"].contains(&name.as_str()) && value["environment"]["ELECTRON_RUN_AS_NODE"] == "1";
  let compiler_probe = name == "vswhere.exe" && args == ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"];
  if !node_host && !compiler_probe && !["git.exe", "git-lfs.exe", "node.exe", "pnpm.exe", "python.exe", "python3.exe", "python3.13.exe"].contains(&name.as_str()) { return invalid(); }
  let environment = value["environment"].as_object().ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
  if environment.len() > 256 { return invalid(); }
  let mut selected = BTreeMap::new(); let mut names = BTreeSet::new();
  for (key, raw) in environment {
    let val = raw.as_str().ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
    if key.is_empty() || key.contains(['=', '\0']) || val.contains('\0') || !names.insert(key.to_ascii_uppercase()) { return invalid(); }
    selected.insert(key.to_ascii_uppercase(), val.to_owned());
  }
  let mut block = Vec::new(); for (key, val) in selected { block.extend(format!("{key}={val}").encode_utf16()); block.push(0); } block.push(0);
  if block.len() > 32_767 { return invalid(); }
  let timeout = value["timeoutMs"].as_u64().ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
  if timeout == 0 || timeout > 3_600_000 { return invalid(); }
  Ok(Request { nonce, executable, args, cwd, environment: block, timeout: Duration::from_millis(timeout), journal_directory, journal })
}

fn durable_proof(directory: &str, name: &str, value: &Value) -> io::Result<()> {
  let root = Path::new(directory); let target = root.join(name); let temporary = root.join(format!(".{name}.write"));
  if target.exists() { return invalid(); }
  let mut file = OpenOptions::new().create_new(true).write(true).open(&temporary)?;
  serde_json::to_writer(&mut file, value)?; file.write_all(b"\n")?; file.sync_all()?; drop(file); fs::rename(temporary, target)
}
fn birth(process: HANDLE) -> io::Result<String> {
  let mut creation: FILETIME = unsafe { mem::zeroed() }; let mut exit: FILETIME = unsafe { mem::zeroed() };
  let mut kernel: FILETIME = unsafe { mem::zeroed() }; let mut user: FILETIME = unsafe { mem::zeroed() };
  if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 { return Err(io::Error::last_os_error()); }
  Ok((((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64).to_string())
}
type Output = Arc<Mutex<io::Stdout>>;
fn emit(output: &Output, message: Value) -> io::Result<()> {
  let mut writer = output.lock().map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
  serde_json::to_writer(&mut *writer, &message)?; writer.write_all(b"\n")?; writer.flush()
}
fn pipe() -> io::Result<(Handle, Handle)> {
  let mut attributes = SECURITY_ATTRIBUTES { nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: ptr::null_mut(), bInheritHandle: 1 };
  let mut read = ptr::null_mut(); let mut write = ptr::null_mut();
  if unsafe { CreatePipe(&mut read, &mut write, &mut attributes, 0) } == 0 { return Err(io::Error::last_os_error()); }
  let read = Handle::new(read)?; let write = Handle::new(write)?;
  if unsafe { SetHandleInformation(read.0, HANDLE_FLAG_INHERIT, 0) } == 0 { return Err(io::Error::last_os_error()); } Ok((read, write))
}
struct Job { job: Handle, process: Handle, thread: Handle, pid: u32, creation: u64, stdout: Handle, stderr: Handle }
impl Job {
  fn start(request: &Request) -> io::Result<Self> {
    let job = Handle::new(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) })?;
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe { SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), mem::size_of_val(&limits) as u32) } == 0 { return Err(io::Error::last_os_error()); }
    let (stdout, stdout_write) = pipe()?; let (stderr, stderr_write) = pipe()?;
    let attributes = SECURITY_ATTRIBUTES { nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: ptr::null_mut(), bInheritHandle: 1 };
    let nul = Handle::new(unsafe { CreateFileW(wide("NUL").as_ptr(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, OPEN_EXISTING, 0, ptr::null_mut()) })?;
    let mut attribute_size = 0;
    unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut attribute_size); }
    let mut attribute_storage = vec![0usize; (attribute_size + mem::size_of::<usize>() - 1) / mem::size_of::<usize>()];
    let list = attribute_storage.as_mut_ptr().cast();
    if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut attribute_size) } == 0 { return Err(io::Error::last_os_error()); }
    struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
    impl Drop for Attributes { fn drop(&mut self) { unsafe { DeleteProcThreadAttributeList(self.0); } } }
    let attribute_guard = Attributes(list); let handles = [nul.0, stdout_write.0, stderr_write.0];
    if unsafe { UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, handles.as_ptr().cast(), mem::size_of_val(&handles), ptr::null_mut(), ptr::null()) } == 0 { return Err(io::Error::last_os_error()); }
    let mut startup: STARTUPINFOEXW = unsafe { mem::zeroed() }; startup.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = nul.0;
    startup.StartupInfo.hStdOutput = stdout_write.0; startup.StartupInfo.hStdError = stderr_write.0; startup.lpAttributeList = list;
    let command = std::iter::once(request.executable.as_str()).chain(request.args.iter().map(String::as_str)).map(quote).collect::<Vec<_>>().join(" ");
    let mut command = wide(&command); if command.len() > 32_767 { return invalid(); }
    let mut process: PROCESS_INFORMATION = unsafe { mem::zeroed() };
    if unsafe { CreateProcessW(wide(&request.executable).as_ptr(), command.as_mut_ptr(), ptr::null(), ptr::null(), 1,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
      request.environment.as_ptr().cast(), wide(&request.cwd).as_ptr(), &startup.StartupInfo, &mut process) } == 0 { return Err(io::Error::last_os_error()); }
    drop(attribute_guard);
    let child = Handle::new(process.hProcess)?; let thread = Handle::new(process.hThread)?;
    if unsafe { AssignProcessToJobObject(job.0, child.0) } == 0 {
      unsafe { TerminateProcess(child.0, 1); WaitForSingleObject(child.0, 3000); } return Err(io::Error::last_os_error());
    }
    let mut creation: FILETIME = unsafe { mem::zeroed() }; let mut exit: FILETIME = unsafe { mem::zeroed() };
    let mut kernel: FILETIME = unsafe { mem::zeroed() }; let mut user: FILETIME = unsafe { mem::zeroed() };
    if unsafe { GetProcessTimes(child.0, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 { return Err(io::Error::last_os_error()); }
    Ok(Self { job, process: child, thread, pid: process.dwProcessId, creation: ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64, stdout, stderr })
  }
  fn active(&self) -> io::Result<u32> {
    let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { mem::zeroed() };
    if unsafe { QueryInformationJobObject(self.job.0, JobObjectBasicAccountingInformation, (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(), mem::size_of_val(&accounting) as u32, ptr::null_mut()) } == 0 { return Err(io::Error::last_os_error()); }
    Ok(accounting.ActiveProcesses)
  }
}
fn stream(handle: Handle, output: Output, nonce: String, kind: &'static str, broken: Arc<AtomicBool>) -> thread::JoinHandle<()> {
  thread::spawn(move || { let mut file = handle.file(); let mut buffer = [0u8; 4096];
    loop { match file.read(&mut buffer) { Ok(0) => return, Ok(count) => {
      let data = buffer[..count].iter().map(|byte| format!("{byte:02x}")).collect::<String>();
      if emit(&output, json!({"protocol":1,"nonce":nonce,"event":kind,"data":data})).is_err() { broken.store(true, Ordering::SeqCst); return; }
    }, Err(_) => { broken.store(true, Ordering::SeqCst); return; } } }
  })
}
fn run() -> io::Result<()> {
  if std::env::args_os().len() != 1 { return invalid(); }
  let mut reader = BufReader::new(io::stdin()); let request = request(line(&mut reader)?.ok_or_else(|| io::Error::from(io::ErrorKind::UnexpectedEof))?)?;
  let output = Arc::new(Mutex::new(io::stdout())); let broken = Arc::new(AtomicBool::new(false));
  let Job { job, process, thread, pid, creation, stdout, stderr } = Job::start(&request)?;
  let owner = Job { job, process, thread, pid, creation, stdout: Handle(ptr::null_mut()), stderr: Handle(ptr::null_mut()) };
  let mut proof = request.journal.clone();
  let proof_object = proof.as_object_mut().ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
  proof_object.insert("pid".into(), json!(pid)); proof_object.insert("identity".into(), json!(creation.to_string()));
  proof_object.insert("helperPid".into(), json!(unsafe { GetCurrentProcessId() })); proof_object.insert("helperBirth".into(), json!(birth(unsafe { GetCurrentProcess() })?));
  durable_proof(&request.journal_directory, "started.json", &proof)?;
  if unsafe { ResumeThread(owner.thread.0) } == u32::MAX { return Err(io::Error::last_os_error()); }
  if emit(&output, json!({"protocol":1,"nonce":request.nonce,"event":"started","pid":pid,"identity":creation.to_string()})).is_err() { broken.store(true, Ordering::SeqCst); }
  let out = stream(stdout, output.clone(), request.nonce.clone(), "stdout", broken.clone());
  let err = stream(stderr, output.clone(), request.nonce.clone(), "stderr", broken.clone());
  let (send, receive) = mpsc::channel(); let nonce = request.nonce.clone();
  thread::spawn(move || {
    let valid = match line(&mut reader) {
      Ok(Some(value)) => exact(&value, &["protocol","nonce","action"]) && value["protocol"] == 1 && value["nonce"] == nonce && value["action"] == "cancel",
      Ok(None) => true, Err(_) => false
    }; let _ = send.send(valid);
  });
  let deadline = Instant::now() + request.timeout; let mut cancelled = false; let mut protocol_valid = true;
  loop {
    match receive.try_recv() { Ok(valid) => { cancelled = true; protocol_valid = valid; break; }, Err(mpsc::TryRecvError::Disconnected) => { cancelled = true; break; }, Err(_) => {} }
    if broken.load(Ordering::SeqCst) || Instant::now() >= deadline { cancelled = true; break; }
    match unsafe { WaitForSingleObject(owner.process.0, 20) } { WAIT_OBJECT_0 => break, WAIT_TIMEOUT => {}, _ => return Err(io::Error::last_os_error()) }
  }
  let mut exit_code = 1u32;
  if unsafe { GetExitCodeProcess(owner.process.0, &mut exit_code) } == 0 { return Err(io::Error::last_os_error()); }
  let grace = Instant::now() + Duration::from_millis(if cancelled { 0 } else { 200 });
  while owner.active()? > 0 && Instant::now() < grace { thread::sleep(Duration::from_millis(10)); }
  let forced_descendants = !cancelled && owner.active()? > 0;
  let until = Instant::now() + Duration::from_secs(5);
  loop {
    if owner.active()? == 0 && unsafe { WaitForSingleObject(owner.process.0, 0) } == WAIT_OBJECT_0 { break; }
    if unsafe { TerminateJobObject(owner.job.0, 1) } == 0 || Instant::now() >= until { return Err(io::Error::last_os_error()); }
    thread::sleep(Duration::from_millis(10));
  }
  out.join().map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?; err.join().map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
  if unsafe { GetExitCodeProcess(owner.process.0, &mut exit_code) } == 0 { return Err(io::Error::last_os_error()); }
  let retired = proof.as_object_mut().ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
  retired.insert("activeProcesses".into(), json!(0)); retired.insert("exitCode".into(), json!(exit_code));
  retired.insert("cancelled".into(), json!(cancelled || !protocol_valid || broken.load(Ordering::SeqCst)));
  retired.insert("forcedDescendants".into(), json!(forced_descendants));
  durable_proof(&request.journal_directory, "retired.json", &proof)?;
  if !protocol_valid || broken.load(Ordering::SeqCst) { return invalid(); }
  emit(&output, json!({"protocol":1,"nonce":request.nonce,"event":"retired","pid":pid,"identity":creation.to_string(),
    "activeProcesses":0,"exitCode":exit_code,"cancelled":cancelled,"forcedDescendants":forced_descendants}))
}
fn main() { if run().is_err() { std::process::exit(2); } }

#[cfg(test)] mod tests {
  use super::*;
  #[test] fn command_line_quotes_preserve_backslashes_and_empty_arguments() {
    assert_eq!(quote(""), "\"\""); assert_eq!(quote("a b"), "\"a b\"");
    assert_eq!(quote("a\\\"b\\"), "\"a\\\\\\\"b\\\\\"");
  }
}
