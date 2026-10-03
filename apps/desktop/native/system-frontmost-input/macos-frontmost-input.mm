#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>

#include <libproc.h>
#include <node_api.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <unistd.h>

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <limits>
#include <thread>

namespace {

using Clock = std::chrono::steady_clock;
using Deadline = Clock::time_point;
constexpr auto kCaptureTimeout = std::chrono::milliseconds(300);
constexpr auto kEffectTimeout = std::chrono::milliseconds(600);
constexpr auto kActivationTimeout = std::chrono::milliseconds(120);
constexpr auto kKeyPairDelay = std::chrono::milliseconds(20);

// The native identity denotes an exact application instance, not a window ID.
struct Target {
  pid_t process;
  std::uint64_t birth;
};

template <typename T>
class ScopedCF {
 public:
  explicit ScopedCF(T value) : value_(value) {}
  ~ScopedCF() { if (value_ != nullptr) CFRelease(value_); }
  ScopedCF(const ScopedCF&) = delete;
  ScopedCF& operator=(const ScopedCF&) = delete;
  T get() const { return value_; }
 private:
  T value_;
};

napi_value Fail(napi_env environment, std::int32_t code, const char* message,
                bool invalid_argument = false) {
  napi_value detail;
  napi_value error;
  napi_value identifier;
  if (napi_create_string_utf8(environment, message, NAPI_AUTO_LENGTH, &detail) != napi_ok ||
      (invalid_argument ? napi_create_type_error(environment, nullptr, detail, &error) :
                          napi_create_error(environment, nullptr, detail, &error)) != napi_ok ||
      napi_create_int32(environment, code, &identifier) != napi_ok ||
      napi_set_named_property(environment, error, "code", identifier) != napi_ok ||
      napi_throw(environment, error) != napi_ok) {
    napi_throw_error(environment, nullptr, "The targeted system input error could not be published.");
  }
  return nullptr;
}

bool RequireAccess(napi_env environment) {
  if (![NSThread isMainThread]) {
    Fail(environment, 13, "Targeted system input requires the application main thread.");
    return false;
  }
  if (@available(macOS 10.15, *)) {
    if (AXIsProcessTrusted() && CGPreflightPostEventAccess()) return true;
  }
  Fail(environment, 9, "Targeted system input permission is unavailable.");
  return false;
}

bool WithinDeadline(napi_env environment, Deadline deadline) {
  if (Clock::now() < deadline) return true;
  Fail(environment, 10, "Targeted system input exceeded its deadline.");
  return false;
}

bool ReadBirth(pid_t process, std::uint64_t* birth) {
  if (process <= 0) return false;
  proc_bsdinfo information{};
  if (proc_pidinfo(process, PROC_PIDTBSDINFO, 0, &information, sizeof(information)) != sizeof(information) ||
      information.pbi_pid != static_cast<std::uint32_t>(process) || information.pbi_status == SZOMB ||
      information.pbi_start_tvusec >= 1'000'000 ||
      information.pbi_start_tvsec > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()) / 1'000'000) {
    return false;
  }
  const std::uint64_t value = information.pbi_start_tvsec * 1'000'000 + information.pbi_start_tvusec;
  if (value == 0 || value > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) return false;
  *birth = value;
  return true;
}

bool SameTarget(const Target& first, const Target& second) {
  return first.process == second.process && first.birth == second.birth;
}

// AX queries the application accepting keyboard input directly. AppKit's
// time-varying properties may remain unchanged until the next run-loop turn.
bool ReadFrontmost(Deadline deadline, Target* target) {
  const auto remaining = std::chrono::duration<double>(deadline - Clock::now()).count();
  if (remaining <= 0) return false;
  const ScopedCF<AXUIElementRef> system(AXUIElementCreateSystemWide());
  if (system.get() == nullptr ||
      AXUIElementSetMessagingTimeout(system.get(), static_cast<float>(std::min(0.12, remaining))) != kAXErrorSuccess) {
    return false;
  }
  CFTypeRef value = nullptr;
  const AXError result = AXUIElementCopyAttributeValue(system.get(), kAXFocusedApplicationAttribute, &value);
  const ScopedCF<CFTypeRef> application(value);
  pid_t process = 0;
  std::uint64_t birth = 0;
  if (result != kAXErrorSuccess || application.get() == nullptr ||
      CFGetTypeID(application.get()) != AXUIElementGetTypeID() ||
      AXUIElementGetPid(static_cast<AXUIElementRef>(const_cast<void*>(application.get())), &process) != kAXErrorSuccess ||
      !ReadBirth(process, &birth) || Clock::now() >= deadline) {
    return false;
  }
  *target = { process, birth };
  return true;
}

bool ConfirmTarget(napi_env environment, const Target& target, Deadline deadline) {
  if (!WithinDeadline(environment, deadline)) return false;
  if (target.process == getpid()) {
    Fail(environment, 11, "Targeted system input requires an external application instance.");
    return false;
  }
  std::uint64_t observed = 0;
  if (!ReadBirth(target.process, &observed) || observed != target.birth) {
    Fail(environment, 3, "The targeted system application instance is unavailable or changed.");
    return false;
  }
  NSRunningApplication* application = [NSRunningApplication runningApplicationWithProcessIdentifier:target.process];
  if (application == nil || application.processIdentifier != target.process || application.terminated) {
    Fail(environment, 3, "The targeted system application has terminated.");
    return false;
  }
  return WithinDeadline(environment, deadline);
}

bool ReadTargetArguments(napi_env environment, napi_callback_info information,
                         bool scroll, Target* target, std::int32_t* wheel) {
  napi_value arguments[4];
  size_t count = scroll ? 4 : 3;
  if (napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr) != napi_ok ||
      count != (scroll ? 3 : 2)) {
    Fail(environment, 2, "Targeted system input received invalid arguments.", true);
    return false;
  }
  napi_valuetype identifier_type;
  napi_valuetype process_type;
  size_t identifier_length = 0;
  if (napi_typeof(environment, arguments[0], &identifier_type) != napi_ok || identifier_type != napi_string ||
      napi_get_value_string_utf8(environment, arguments[0], nullptr, 0, &identifier_length) != napi_ok ||
      identifier_length == 0 || identifier_length > 19 ||
      napi_typeof(environment, arguments[1], &process_type) != napi_ok || process_type != napi_number) {
    Fail(environment, 2, "Targeted system input requires an exact application and process identity.", true);
    return false;
  }
  char identifier[20];
  size_t copied = 0;
  if (napi_get_value_string_utf8(environment, arguments[0], identifier, sizeof(identifier), &copied) != napi_ok ||
      copied != identifier_length || identifier[0] < '1' || identifier[0] > '9') {
    Fail(environment, 2, "The targeted system application identity is invalid.", true);
    return false;
  }
  for (size_t index = 1; index < identifier_length; ++index) {
    if (identifier[index] < '0' || identifier[index] > '9') {
      Fail(environment, 2, "The targeted system application identity is invalid.", true);
      return false;
    }
  }
  std::uint64_t birth = 0;
  const auto parsed = std::from_chars(identifier, identifier + identifier_length, birth);
  double process = 0;
  if (parsed.ec != std::errc() || parsed.ptr != identifier + identifier_length ||
      birth > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()) ||
      napi_get_value_double(environment, arguments[1], &process) != napi_ok ||
      !std::isfinite(process) || process <= 0 || process > std::numeric_limits<std::int32_t>::max() ||
      std::floor(process) != process) {
    Fail(environment, 2, "The targeted system application or process identity is invalid.", true);
    return false;
  }
  *target = { static_cast<pid_t>(process), birth };
  if (scroll) {
    napi_valuetype wheel_type;
    double amount = 0;
    if (napi_typeof(environment, arguments[2], &wheel_type) != napi_ok || wheel_type != napi_number ||
        napi_get_value_double(environment, arguments[2], &amount) != napi_ok || !std::isfinite(amount) ||
        amount == 0 || amount < -2400 || amount > 2400 || std::floor(amount) != amount) {
      Fail(environment, 2, "The targeted system scroll amount is invalid.", true);
      return false;
    }
    *wheel = static_cast<std::int32_t>(amount);
  }
  return true;
}

napi_value EffectComplete(napi_env environment) {
  napi_value result;
  if (napi_get_undefined(environment, &result) != napi_ok) {
    return Fail(environment, 12, "The targeted system input result could not be published.");
  }
  // CGEventPostToPid has no delivery acknowledgement. Completion means issued.
  return result;
}

napi_value PostKeyPair(napi_env environment, const Target& target, CGKeyCode key,
                       CGEventFlags flags, Deadline deadline) {
  const ScopedCF<CGEventSourceRef> source(CGEventSourceCreate(kCGEventSourceStatePrivate));
  const ScopedCF<CGEventRef> down(source.get() == nullptr ? nullptr : CGEventCreateKeyboardEvent(source.get(), key, true));
  const ScopedCF<CGEventRef> up(source.get() == nullptr ? nullptr : CGEventCreateKeyboardEvent(source.get(), key, false));
  if (source.get() == nullptr || down.get() == nullptr || up.get() == nullptr) {
    return Fail(environment, 8, "The targeted system key events could not be created.");
  }
  CGEventSetFlags(down.get(), flags);
  CGEventSetFlags(up.get(), flags);
  if (!RequireAccess(environment) || !ConfirmTarget(environment, target, deadline)) return nullptr;
  if (deadline - Clock::now() <= kKeyPairDelay) {
    return Fail(environment, 10, "Targeted system input exceeded its key-pair deadline.");
  }
  CGEventPostToPid(target.process, down.get());
  std::this_thread::sleep_for(kKeyPairDelay);
  if (!RequireAccess(environment) || !ConfirmTarget(environment, target, deadline)) return nullptr;
  CGEventPostToPid(target.process, up.get());
  return EffectComplete(environment);
}

napi_value PostReturn(napi_env environment, napi_callback_info information) {
  @autoreleasepool {
    Target target;
    if (!ReadTargetArguments(environment, information, false, &target, nullptr) || !RequireAccess(environment)) return nullptr;
    const auto deadline = Clock::now() + kEffectTimeout;
    if (!ConfirmTarget(environment, target, deadline)) return nullptr;
    return PostKeyPair(environment, target, 36, 0, deadline);
  }
}

napi_value PostScroll(napi_env environment, napi_callback_info information) {
  @autoreleasepool {
    Target target;
    std::int32_t wheel = 0;
    if (!ReadTargetArguments(environment, information, true, &target, &wheel) || !RequireAccess(environment)) return nullptr;
    const auto deadline = Clock::now() + kEffectTimeout;
    if (!ConfirmTarget(environment, target, deadline)) return nullptr;
    const ScopedCF<CGEventSourceRef> source(CGEventSourceCreate(kCGEventSourceStatePrivate));
    const ScopedCF<CGEventRef> event(source.get() == nullptr ? nullptr :
      CGEventCreateScrollWheelEvent(source.get(), kCGScrollEventUnitPixel, 1, wheel));
    if (source.get() == nullptr || event.get() == nullptr) {
      return Fail(environment, 8, "The targeted system scroll event could not be created.");
    }
    CGEventSetFlags(event.get(), 0);
    if (!RequireAccess(environment) || !ConfirmTarget(environment, target, deadline)) return nullptr;
    CGEventPostToPid(target.process, event.get());
    return EffectComplete(environment);
  }
}

napi_value PostPaste(napi_env environment, napi_callback_info information) {
  @autoreleasepool {
    Target target;
    if (!ReadTargetArguments(environment, information, false, &target, nullptr) || !RequireAccess(environment)) return nullptr;
    const auto deadline = Clock::now() + kEffectTimeout;
    if (!ConfirmTarget(environment, target, deadline)) return nullptr;
    Target frontmost;
    if (!ReadFrontmost(deadline, &frontmost)) {
      return Fail(environment, 6, "The system frontmost application identity is unavailable.");
    }
    if (!SameTarget(frontmost, target)) {
      NSRunningApplication* application = [NSRunningApplication runningApplicationWithProcessIdentifier:target.process];
      if (!RequireAccess(environment) || !ConfirmTarget(environment, target, deadline)) return nullptr;
      BOOL requested = NO;
      if (@available(macOS 14.0, *)) requested = [application activateWithOptions:0];
      else requested = [application activateWithOptions:NSApplicationActivateIgnoringOtherApps];
      if (!requested) return Fail(environment, 7, "The targeted system application activation was refused.");
      const auto activation_deadline = std::min(deadline, Clock::now() + kActivationTimeout);
      while (true) {
        if (!RequireAccess(environment) || !ConfirmTarget(environment, target, activation_deadline)) return nullptr;
        if (!ReadFrontmost(activation_deadline, &frontmost)) {
          return Fail(environment, 7, "The targeted system application activation could not be confirmed.");
        }
        if (SameTarget(frontmost, target)) break;
        if (Clock::now() >= activation_deadline) {
          return Fail(environment, 7, "The targeted system application activation was not granted.");
        }
        std::this_thread::sleep_for(std::min(std::chrono::milliseconds(5),
          std::chrono::duration_cast<std::chrono::milliseconds>(activation_deadline - Clock::now())));
      }
    }
    Target confirmed;
    if (!RequireAccess(environment) || !ConfirmTarget(environment, target, deadline)) return nullptr;
    if (!ReadFrontmost(deadline, &confirmed) || !SameTarget(confirmed, target)) {
      return Fail(environment, 6, "The targeted system paste application is no longer frontmost.");
    }
    return PostKeyPair(environment, target, 9, kCGEventFlagMaskCommand, deadline);
  }
}

napi_value CaptureTarget(napi_env environment, napi_callback_info information) {
  @autoreleasepool {
    napi_value argument;
    size_t count = 1;
    if (napi_get_cb_info(environment, information, &count, &argument, nullptr, nullptr) != napi_ok || count != 0) {
      return Fail(environment, 2, "System frontmost capture does not accept arguments.", true);
    }
    if (!RequireAccess(environment)) return nullptr;
    const auto deadline = Clock::now() + kCaptureTimeout;
    Target first;
    Target second;
    if (!ReadFrontmost(deadline, &first) || !ConfirmTarget(environment, first, deadline)) {
      bool pending = false;
      if (napi_is_exception_pending(environment, &pending) == napi_ok && pending) return nullptr;
      return Fail(environment, 6, "The system frontmost application identity is unavailable.");
    }
    if (!ReadFrontmost(deadline, &second) || !SameTarget(first, second)) {
      return Fail(environment, 6, "The system frontmost application identity changed during capture.");
    }
    if (!RequireAccess(environment) || !ConfirmTarget(environment, second, deadline)) return nullptr;
    char native_id[20];
    const auto converted = std::to_chars(native_id, native_id + sizeof(native_id), first.birth);
    if (converted.ec != std::errc()) return Fail(environment, 12, "The system frontmost application identity could not be represented.");
    napi_value target;
    napi_value identifier;
    napi_value process;
    if (napi_create_object(environment, &target) != napi_ok ||
        napi_create_string_utf8(environment, native_id, converted.ptr - native_id, &identifier) != napi_ok ||
        napi_create_uint32(environment, static_cast<std::uint32_t>(first.process), &process) != napi_ok ||
        napi_set_named_property(environment, target, "nativeId", identifier) != napi_ok ||
        napi_set_named_property(environment, target, "processId", process) != napi_ok) {
      return Fail(environment, 12, "The system frontmost application identity could not be published.");
    }
    return target;
  }
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_value version;
  napi_value capture;
  napi_value post_return;
  napi_value post_scroll;
  napi_value post_paste;
  // Module loading only publishes the contract; it does not sample an app.
  if (napi_create_uint32(env, 1, &version) != napi_ok ||
      napi_create_function(env, "captureTarget", NAPI_AUTO_LENGTH, CaptureTarget, nullptr, &capture) != napi_ok ||
      napi_create_function(env, "postReturn", NAPI_AUTO_LENGTH, PostReturn, nullptr, &post_return) != napi_ok ||
      napi_create_function(env, "postScroll", NAPI_AUTO_LENGTH, PostScroll, nullptr, &post_scroll) != napi_ok ||
      napi_create_function(env, "postPaste", NAPI_AUTO_LENGTH, PostPaste, nullptr, &post_paste) != napi_ok ||
      napi_set_named_property(env, exports, "protocolVersion", version) != napi_ok ||
      napi_set_named_property(env, exports, "captureTarget", capture) != napi_ok ||
      napi_set_named_property(env, exports, "postReturn", post_return) != napi_ok ||
      napi_set_named_property(env, exports, "postScroll", post_scroll) != napi_ok ||
      napi_set_named_property(env, exports, "postPaste", post_paste) != napi_ok) {
    return Fail(env, 12, "The system frontmost native module could not initialize.");
  }
  return exports;
}
