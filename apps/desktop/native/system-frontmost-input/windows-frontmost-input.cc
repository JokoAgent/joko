#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <delayimp.h>
#include <node_api.h>

#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>

namespace {

// Electron exports Node-API from its running executable. Resolve the delayed
// node.exe import against that image without loading a second executable.
FARPROC WINAPI ResolveHost(unsigned int notification, DelayLoadInfo* information) {
  if (notification != dliNotePreLoadLibrary || information == nullptr ||
      information->szDll == nullptr || _stricmp(information->szDll, "node.exe") != 0) {
    return nullptr;
  }
  return reinterpret_cast<FARPROC>(GetModuleHandleW(nullptr));
}

napi_value Fail(napi_env environment, const char* message) {
  napi_throw_error(environment, nullptr, message);
  return nullptr;
}

napi_value FailEffect(napi_env environment, std::int32_t code,
                      const char* message, bool invalid_argument = false) {
  napi_value detail;
  napi_value error;
  napi_value identifier;
  if (napi_create_string_utf8(environment, message, NAPI_AUTO_LENGTH, &detail) != napi_ok ||
      (invalid_argument ? napi_create_type_error(environment, nullptr, detail, &error) :
                          napi_create_error(environment, nullptr, detail, &error)) != napi_ok ||
      napi_create_int32(environment, code, &identifier) != napi_ok ||
      napi_set_named_property(environment, error, "code", identifier) != napi_ok ||
      napi_throw(environment, error) != napi_ok) {
    return Fail(environment, "The targeted system input error could not be published.");
  }
  return nullptr;
}

struct Target {
  HWND window;
  DWORD process;
};

bool ReadTargetArguments(napi_env environment, napi_callback_info information,
                         bool scroll, Target* target, std::int32_t* wheel) {
  napi_value arguments[4];
  size_t count = scroll ? 4 : 3;
  if (napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr) != napi_ok ||
      count != (scroll ? 3 : 2)) {
    FailEffect(environment, 2, "Targeted system input received invalid arguments.", true);
    return false;
  }
  napi_valuetype identifier_type;
  napi_valuetype process_type;
  size_t identifier_length = 0;
  if (napi_typeof(environment, arguments[0], &identifier_type) != napi_ok ||
      identifier_type != napi_string ||
      napi_get_value_string_utf8(environment, arguments[0], nullptr, 0,
                                 &identifier_length) != napi_ok ||
      identifier_length == 0 || identifier_length > 19 ||
      napi_typeof(environment, arguments[1], &process_type) != napi_ok ||
      process_type != napi_number) {
    FailEffect(environment, 2, "Targeted system input requires an exact window and process identity.", true);
    return false;
  }
  char identifier[20];
  size_t copied = 0;
  if (napi_get_value_string_utf8(environment, arguments[0], identifier,
                                 sizeof(identifier), &copied) != napi_ok ||
      copied != identifier_length || identifier[0] < '1' || identifier[0] > '9') {
    FailEffect(environment, 2, "The targeted system window identity is invalid.", true);
    return false;
  }
  for (size_t index = 1; index < identifier_length; ++index) {
    if (identifier[index] < '0' || identifier[index] > '9') {
      FailEffect(environment, 2, "The targeted system window identity is invalid.", true);
      return false;
    }
  }
  std::uint64_t native_id = 0;
  const auto parsed = std::from_chars(identifier, identifier + identifier_length, native_id);
  double process = 0;
  if (parsed.ec != std::errc() || parsed.ptr != identifier + identifier_length ||
      native_id > static_cast<std::uint64_t>((std::numeric_limits<std::int64_t>::max)()) ||
      native_id > static_cast<std::uint64_t>((std::numeric_limits<std::uintptr_t>::max)()) ||
      napi_get_value_double(environment, arguments[1], &process) != napi_ok ||
      !std::isfinite(process) || process <= 0 || process > 4'294'967'295.0 ||
      std::floor(process) != process) {
    FailEffect(environment, 2, "The targeted system window or process identity is invalid.", true);
    return false;
  }
  target->window = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(native_id));
  target->process = static_cast<DWORD>(process);
  if (scroll) {
    napi_valuetype wheel_type;
    double amount = 0;
    if (napi_typeof(environment, arguments[2], &wheel_type) != napi_ok ||
        wheel_type != napi_number ||
        napi_get_value_double(environment, arguments[2], &amount) != napi_ok ||
        !std::isfinite(amount) || amount == 0 || amount < -2400 || amount > 2400 ||
        std::floor(amount) != amount) {
      FailEffect(environment, 2, "The targeted system scroll amount is invalid.", true);
      return false;
    }
    *wheel = static_cast<std::int32_t>(amount);
  }
  return true;
}

bool ConfirmTarget(napi_env environment, const Target& target,
                   DWORD expected_thread, DWORD* thread = nullptr) {
  DWORD process = 0;
  const DWORD observed_thread = GetWindowThreadProcessId(target.window, &process);
  if (process == 0 || process != target.process || observed_thread == 0) {
    FailEffect(environment, 3, "The targeted system process identity is unavailable or changed.");
    return false;
  }
  if (process == GetCurrentProcessId()) {
    FailEffect(environment, 11, "Targeted system input requires an external process.");
    return false;
  }
  if (expected_thread != 0 && observed_thread != expected_thread) {
    FailEffect(environment, 6, "The targeted system window thread changed.");
    return false;
  }
  if (thread != nullptr) *thread = observed_thread;
  return true;
}

napi_value EffectComplete(napi_env environment) {
  napi_value result;
  if (napi_get_undefined(environment, &result) != napi_ok) {
    return FailEffect(environment, 12, "The targeted system input result could not be published.");
  }
  return result;
}

napi_value PostReturn(napi_env environment, napi_callback_info information) {
  Target target;
  DWORD thread = 0;
  if (!ReadTargetArguments(environment, information, false, &target, nullptr) ||
      !ConfirmTarget(environment, target, 0, &thread)) return nullptr;
  if (!PostMessageW(target.window, WM_KEYDOWN, VK_RETURN, 0)) {
    return FailEffect(environment, 4, "The targeted system Return press was refused.");
  }
  if (!ConfirmTarget(environment, target, thread)) return nullptr;
  if (!PostMessageW(target.window, WM_KEYUP, VK_RETURN, 0)) {
    return FailEffect(environment, 5, "The targeted system Return release was refused.");
  }
  return EffectComplete(environment);
}

napi_value PostScroll(napi_env environment, napi_callback_info information) {
  Target target;
  std::int32_t wheel = 0;
  if (!ReadTargetArguments(environment, information, true, &target, &wheel) ||
      !ConfirmTarget(environment, target, 0)) return nullptr;
  const WPARAM amount = static_cast<WPARAM>(static_cast<std::uint32_t>(
      static_cast<std::uint16_t>(wheel)) << 16);
  if (!PostMessageW(target.window, WM_MOUSEWHEEL, amount, 0)) {
    return FailEffect(environment, 5, "The targeted system scroll was refused.");
  }
  return EffectComplete(environment);
}

class FocusAttachment {
 public:
  FocusAttachment(DWORD source, DWORD target) : source_(source), target_(target) {}
  ~FocusAttachment() { Detach(); }
  bool Attach() {
    if (source_ == target_) return true;
    attached_ = AttachThreadInput(source_, target_, TRUE) != FALSE;
    return attached_;
  }
  bool Detach() {
    if (!attached_) return true;
    attached_ = false;
    return AttachThreadInput(source_, target_, FALSE) != FALSE;
  }
 private:
  DWORD source_;
  DWORD target_;
  bool attached_ = false;
};

bool ConfirmPasteFocus(napi_env environment, const Target& target,
                       DWORD thread, HWND focus) {
  if (GetForegroundWindow() != target.window) {
    FailEffect(environment, 5, "The targeted system paste foreground changed.");
    return false;
  }
  if (!ConfirmTarget(environment, target, thread)) return false;
  if (focus == nullptr || GetFocus() != focus) {
    FailEffect(environment, 8, "The targeted system paste focus is unavailable or changed.");
    return false;
  }
  DWORD focus_process = 0;
  const DWORD focus_thread = GetWindowThreadProcessId(focus, &focus_process);
  if (focus_thread == 0 || focus_process == 0 || focus_process != target.process) {
    FailEffect(environment, 3, "The targeted system paste focus process changed.");
    return false;
  }
  if (GetAncestor(focus, GA_ROOT) != target.window) {
    FailEffect(environment, 9, "The targeted system paste focus belongs to another window.");
    return false;
  }
  if (GetForegroundWindow() != target.window) {
    FailEffect(environment, 5, "The targeted system paste foreground changed.");
    return false;
  }
  return true;
}

napi_value PostPaste(napi_env environment, napi_callback_info information) {
  Target target;
  DWORD thread = 0;
  if (!ReadTargetArguments(environment, information, false, &target, nullptr) ||
      !ConfirmTarget(environment, target, 0, &thread)) return nullptr;
  if (GetForegroundWindow() != target.window && !SetForegroundWindow(target.window)) {
    return FailEffect(environment, 4, "The targeted system paste foreground request was refused.");
  }
  if (GetForegroundWindow() != target.window) {
    return FailEffect(environment, 5, "The targeted system paste foreground could not be confirmed.");
  }
  if (!ConfirmTarget(environment, target, thread)) return nullptr;
  const DWORD source_thread = GetCurrentThreadId();
  FocusAttachment attachment(source_thread, thread);
  if (source_thread == 0 || !attachment.Attach()) {
    return FailEffect(environment, 7, "The targeted system paste focus could not be attached.");
  }
  const HWND focus = GetFocus();
  if (!ConfirmPasteFocus(environment, target, thread, focus)) return nullptr;
  if (!PostMessageW(focus, WM_PASTE, 0, 0)) {
    return FailEffect(environment, 10, "The targeted system paste was refused.");
  }
  if (!attachment.Detach()) {
    return FailEffect(environment, 12, "The targeted system paste focus could not be detached.");
  }
  return EffectComplete(environment);
}

napi_value CaptureTarget(napi_env environment, napi_callback_info information) {
  size_t argument_count = 1;
  napi_value argument;
  if (napi_get_cb_info(environment, information, &argument_count, &argument,
                       nullptr, nullptr) != napi_ok) {
    return Fail(environment, "The system frontmost capture could not read its arguments.");
  }
  if (argument_count != 0) {
    napi_throw_type_error(environment, nullptr, "System frontmost capture takes no arguments.");
    return nullptr;
  }

  // These reads all run synchronously inside the physical activation callback.
  // Each PID is resolved from its exact HWND, with no cached foreground state.
  const HWND first_window = GetForegroundWindow();
  DWORD first_process = 0;
  const DWORD first_thread = first_window == nullptr ? 0 :
      GetWindowThreadProcessId(first_window, &first_process);
  const HWND second_window = GetForegroundWindow();
  DWORD second_process = 0;
  const DWORD second_thread = second_window == nullptr ? 0 :
      GetWindowThreadProcessId(second_window, &second_process);
  if (first_window == nullptr || second_window != first_window ||
      first_process == 0 || second_process != first_process ||
      first_thread == 0 || second_thread != first_thread ||
      GetForegroundWindow() != second_window) {
    return Fail(environment, "The system frontmost target identity is unavailable or changed.");
  }

  char native_id[21];
  const auto converted = std::to_chars(native_id, native_id + sizeof(native_id),
      reinterpret_cast<std::uintptr_t>(first_window));
  if (converted.ec != std::errc()) {
    return Fail(environment, "The system frontmost target could not be represented.");
  }

  napi_value target;
  napi_value identifier;
  napi_value process_id;
  if (napi_create_object(environment, &target) != napi_ok ||
      napi_create_string_utf8(environment, native_id, converted.ptr - native_id,
                              &identifier) != napi_ok ||
      napi_create_uint32(environment, first_process, &process_id) != napi_ok ||
      napi_set_named_property(environment, target, "nativeId", identifier) != napi_ok ||
      napi_set_named_property(environment, target, "processId", process_id) != napi_ok) {
    return Fail(environment, "The system frontmost target could not be published.");
  }
  return target;
}

}  // namespace

extern "C" decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = ResolveHost;

NAPI_MODULE_INIT() {
  napi_value version;
  napi_value capture;
  napi_value post_return;
  napi_value post_scroll;
  napi_value post_paste;
  // Loading the module only defines its contract. It never samples a window.
  if (napi_create_uint32(env, 1, &version) != napi_ok ||
      napi_create_function(env, "captureTarget", NAPI_AUTO_LENGTH, CaptureTarget,
                           nullptr, &capture) != napi_ok ||
      napi_create_function(env, "postReturn", NAPI_AUTO_LENGTH, PostReturn,
                           nullptr, &post_return) != napi_ok ||
      napi_create_function(env, "postScroll", NAPI_AUTO_LENGTH, PostScroll,
                           nullptr, &post_scroll) != napi_ok ||
      napi_create_function(env, "postPaste", NAPI_AUTO_LENGTH, PostPaste,
                           nullptr, &post_paste) != napi_ok ||
      napi_set_named_property(env, exports, "protocolVersion", version) != napi_ok ||
      napi_set_named_property(env, exports, "captureTarget", capture) != napi_ok ||
      napi_set_named_property(env, exports, "postReturn", post_return) != napi_ok ||
      napi_set_named_property(env, exports, "postScroll", post_scroll) != napi_ok ||
      napi_set_named_property(env, exports, "postPaste", post_paste) != napi_ok) {
    return Fail(env, "The system frontmost native module could not initialize.");
  }
  return exports;
}
