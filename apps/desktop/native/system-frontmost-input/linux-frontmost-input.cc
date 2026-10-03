#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <node_api.h>
#include <xcb/xcb.h>
#include <xcb/xcbext.h>
#include <xcb/res.h>
// The generated C header contains members named with this C++ keyword.
#define explicit explicit_field
#include <xcb/xkb.h>
#undef explicit

#include <fcntl.h>
#include <poll.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;
using Deadline = Clock::time_point;
constexpr auto kCaptureTimeout = std::chrono::milliseconds(300);
constexpr auto kEffectTimeout = std::chrono::milliseconds(600);
constexpr auto kActivationTimeout = std::chrono::milliseconds(120);
constexpr std::size_t kMaximumReplyBytes = 256 * 1024;
constexpr std::size_t kMaximumAuthorityBytes = 1024 * 1024;
constexpr std::size_t kMaximumTargets = 256;
constexpr xcb_keysym_t kReturn = 0xff0d;
constexpr xcb_keysym_t kPasteKey = 0x0076;

struct ProcessInstance {
  pid_t process;
  std::uint64_t start_ticks;
};

bool SameProcess(const ProcessInstance& first, const ProcessInstance& second) {
  return first.process == second.process && first.start_ticks == second.start_ticks;
}

struct ServerPeer {
  ProcessInstance instance;
  uid_t user;
  gid_t group;
};

bool SamePeer(const ServerPeer& first, const ServerPeer& second) {
  return SameProcess(first.instance, second.instance) && first.user == second.user && first.group == second.group;
}

struct ServerIdentity {
  ServerPeer peer;
  int display;
  int screen;
  xcb_window_t root;
};

bool SameServer(const ServerIdentity& first, const ServerIdentity& second) {
  return SamePeer(first.peer, second.peer) && first.display == second.display &&
      first.screen == second.screen && first.root == second.root;
}

struct Target {
  xcb_window_t window;
  ProcessInstance client;
  ServerIdentity server;
};

bool SameTarget(const Target& first, const Target& second) {
  return first.window == second.window && SameProcess(first.client, second.client) &&
      SameServer(first.server, second.server);
}

struct IssuedTarget {
  std::uint64_t token;
  Target identity;
};

struct TargetOwner {
  explicit TargetOwner(napi_env value) : environment(value) { targets.reserve(kMaximumTargets); }
  napi_env environment;
  std::vector<IssuedTarget> targets;
};

void RetireTarget(TargetOwner& owner, std::uint64_t token) {
  const auto entry = std::find_if(owner.targets.begin(), owner.targets.end(),
      [token](const IssuedTarget& target) { return target.token == token; });
  if (entry != owner.targets.end()) owner.targets.erase(entry);
}

class EffectLease {
 public:
  EffectLease(TargetOwner& owner, std::uint64_t token) : owner_(owner), token_(token) {}
  ~EffectLease() { if (!complete_) RetireTarget(owner_, token_); }
  void Complete() { complete_ = true; }
 private:
  TargetOwner& owner_;
  std::uint64_t token_;
  bool complete_ = false;
};

template <typename T>
using Reply = std::unique_ptr<T, decltype(&std::free)>;

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

int RemainingMilliseconds(Deadline deadline) {
  const auto remaining = deadline - Clock::now();
  if (remaining <= Clock::duration::zero()) return 0;
  return static_cast<int>(std::min<std::int64_t>(
      600, std::chrono::duration_cast<std::chrono::milliseconds>(remaining).count() + 1));
}

bool PollDescriptor(int descriptor, short events, Deadline deadline) {
  while (Clock::now() < deadline) {
    pollfd item{descriptor, events, 0};
    const int result = poll(&item, 1, RemainingMilliseconds(deadline));
    if (result > 0) return (item.revents & events) != 0 &&
        (item.revents & (POLLERR | POLLHUP | POLLNVAL)) == 0;
    if (result == 0 || errno != EINTR) return false;
  }
  return false;
}

class Descriptor {
 public:
  explicit Descriptor(int value = -1) : value_(value) {}
  ~Descriptor() { if (value_ >= 0) close(value_); }
  Descriptor(const Descriptor&) = delete;
  Descriptor& operator=(const Descriptor&) = delete;
  int get() const { return value_; }
  int release() { const int result = value_; value_ = -1; return result; }
 private:
  int value_;
};

void Erase(void* storage, std::size_t size) {
  volatile unsigned char* bytes = static_cast<volatile unsigned char*>(storage);
  while (size-- != 0) *bytes++ = 0;
}

class Authority {
 public:
  ~Authority() {
    if (!contents_.empty()) Erase(contents_.data(), contents_.size());
    Erase(cookie_.data(), cookie_.size());
  }

  bool Read(int display, Deadline deadline) {
    const char* configured = std::getenv("XAUTHORITY");
    std::string path;
    if (configured != nullptr && configured[0] != '\0') {
      if (configured[0] != '/' || std::strlen(configured) > 4096) return false;
      path = configured;
    } else {
      const char* directory = std::getenv("HOME");
      if (directory == nullptr || directory[0] != '/' || std::strlen(directory) > 4000) return false;
      path = std::string(directory) + "/.Xauthority";
    }
    const Descriptor file(open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NONBLOCK));
    if (file.get() < 0) return errno == ENOENT && Clock::now() < deadline;
    struct stat information{};
    if (fstat(file.get(), &information) != 0 || !S_ISREG(information.st_mode) ||
        information.st_size < 0 || information.st_size > static_cast<off_t>(kMaximumAuthorityBytes)) return false;
    contents_.resize(static_cast<std::size_t>(information.st_size));
    std::size_t received = 0;
    while (received < contents_.size() && Clock::now() < deadline) {
      const ssize_t amount = read(file.get(), contents_.data() + received, contents_.size() - received);
      if (amount > 0) received += static_cast<std::size_t>(amount);
      else if (amount == 0 || errno != EINTR) return false;
    }
    if (received != contents_.size() || Clock::now() >= deadline) return false;
    char hostname[256]{};
    if (gethostname(hostname, sizeof(hostname) - 1) != 0) return false;
    const std::string number = std::to_string(display);
    std::size_t offset = 0;
    int priority = 0;
    while (offset < contents_.size()) {
      std::uint16_t family = 0;
      std::string_view address;
      std::string_view candidate_number;
      std::string_view name;
      std::string_view value;
      if (!Short(&offset, &family) || !Field(&offset, &address) ||
          !Field(&offset, &candidate_number) || !Field(&offset, &name) || !Field(&offset, &value)) return false;
      const int candidate_priority = family == 256 && address == hostname ? 2 : family == 65535 ? 1 : 0;
      if (candidate_priority == 0 || candidate_number != number ||
          name != "MIT-MAGIC-COOKIE-1" || value.size() != cookie_.size()) continue;
      if (candidate_priority == priority &&
          std::memcmp(cookie_.data(), value.data(), cookie_.size()) != 0) return false;
      if (candidate_priority > priority) {
        std::memcpy(cookie_.data(), value.data(), cookie_.size());
        priority = candidate_priority;
      }
    }
    present_ = priority != 0;
    return Clock::now() < deadline;
  }

  xcb_auth_info_t* get() {
    if (!present_) return nullptr;
    information_.namelen = 18;
    information_.name = const_cast<char*>("MIT-MAGIC-COOKIE-1");
    information_.datalen = static_cast<int>(cookie_.size());
    information_.data = cookie_.data();
    return &information_;
  }

 private:
  bool Short(std::size_t* offset, std::uint16_t* value) {
    if (*offset > contents_.size() || contents_.size() - *offset < 2) return false;
    *value = static_cast<std::uint16_t>((contents_[*offset] << 8) | contents_[*offset + 1]);
    *offset += 2;
    return true;
  }

  bool Field(std::size_t* offset, std::string_view* value) {
    std::uint16_t length = 0;
    if (!Short(offset, &length) || contents_.size() - *offset < length) return false;
    *value = {reinterpret_cast<const char*>(contents_.data() + *offset), length};
    *offset += length;
    return true;
  }

  std::vector<unsigned char> contents_;
  std::array<char, 16> cookie_{};
  xcb_auth_info_t information_{};
  bool present_ = false;
};

bool LocalDisplay(int* display, int* screen) {
  const char* session = std::getenv("XDG_SESSION_TYPE");
  const char* wayland = std::getenv("WAYLAND_DISPLAY");
  const char* name = std::getenv("DISPLAY");
  if (session == nullptr || std::strcmp(session, "x11") != 0 ||
      (wayland != nullptr && wayland[0] != '\0') || name == nullptr ||
      name[0] == '\0' || std::strlen(name) > 128) return false;
  char* host = nullptr;
  const int parsed = xcb_parse_display(name, &host, display, screen);
  const std::unique_ptr<char, decltype(&std::free)> owned_host(host, &std::free);
  return parsed != 0 && host != nullptr &&
      (host[0] == '\0' || std::strcmp(host, "unix") == 0) &&
      *display >= 0 && *display <= 65535 && *screen >= 0 && *screen <= 255;
}

int ConnectLocal(int display, Deadline deadline) {
  const std::string path = "/tmp/.X11-unix/X" + std::to_string(display);
  for (const bool abstract : {false, true}) {
    if (Clock::now() >= deadline) return -1;
    Descriptor socket_descriptor(socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0));
    if (socket_descriptor.get() < 0) return -1;
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    if (path.size() + 1 >= sizeof(address.sun_path)) return -1;
    std::memcpy(address.sun_path + (abstract ? 1 : 0), path.c_str(), path.size() + (abstract ? 0 : 1));
    const socklen_t length = static_cast<socklen_t>(offsetof(sockaddr_un, sun_path) + path.size() + 1);
    const int result = connect(socket_descriptor.get(), reinterpret_cast<sockaddr*>(&address), length);
    if (result != 0 && (errno != EINPROGRESS || !PollDescriptor(socket_descriptor.get(), POLLOUT, deadline))) continue;
    int error = 0;
    socklen_t error_size = sizeof(error);
    if (getsockopt(socket_descriptor.get(), SOL_SOCKET, SO_ERROR, &error, &error_size) != 0 || error != 0) continue;
    return socket_descriptor.release();
  }
  return -1;
}

bool ReadProcessInstance(pid_t process, Deadline deadline, ProcessInstance* instance) {
  if (process <= 0 || Clock::now() >= deadline) return false;
  const std::string path = "/proc/" + std::to_string(process) + "/stat";
  const Descriptor descriptor(open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NONBLOCK));
  struct stat metadata{};
  if (descriptor.get() < 0 || fstat(descriptor.get(), &metadata) != 0 || !S_ISREG(metadata.st_mode)) return false;
  std::array<char, 4096> storage{};
  std::size_t size = 0;
  bool finished = false;
  while (size < storage.size() && Clock::now() < deadline) {
    const ssize_t amount = read(descriptor.get(), storage.data() + size, storage.size() - size);
    if (amount > 0) size += static_cast<std::size_t>(amount);
    else if (amount == 0) { finished = true; break; }
    else if (errno != EINTR) return false;
  }
  if (!finished || size == 0 || Clock::now() >= deadline) return false;
  const std::string_view contents(storage.data(), size);
  const auto opening = contents.find(" (");
  const auto closing = contents.rfind(')');
  pid_t observed = 0;
  if (contents.find('\0') != std::string_view::npos || opening == std::string_view::npos ||
      closing == std::string_view::npos || closing <= opening + 1 || closing + 4 >= size) return false;
  const auto parsed_pid = std::from_chars(contents.data(), contents.data() + opening, observed);
  if (parsed_pid.ec != std::errc() || parsed_pid.ptr != contents.data() + opening || observed != process ||
      contents[closing + 1] != ' ' || contents[closing + 3] != ' ' ||
      contents[closing + 2] == 'Z' || contents[closing + 2] == 'X' || contents[closing + 2] == 'x') return false;
  const char state = contents[closing + 2];
  if (!((state >= 'A' && state <= 'Z') || (state >= 'a' && state <= 'z'))) return false;
  std::size_t offset = closing + 4;
  std::uint64_t start_ticks = 0;
  for (unsigned int field = 4; field <= 22; ++field) {
    const std::size_t start = offset;
    if (field != 22 && offset < size && contents[offset] == '-') ++offset;
    const std::size_t digits = offset;
    while (offset < size && contents[offset] >= '0' && contents[offset] <= '9') ++offset;
    if (offset == digits || offset >= size || contents[offset] != ' ') return false;
    if (field == 22) {
      const auto parsed = std::from_chars(contents.data() + start, contents.data() + offset, start_ticks);
      if (parsed.ec != std::errc() || parsed.ptr != contents.data() + offset || start_ticks == 0) return false;
    }
    ++offset;
  }
  if (Clock::now() >= deadline) return false;
  *instance = {process, start_ticks};
  return true;
}

bool NativeServer(int descriptor, Deadline deadline, ServerPeer* identity) {
  ucred peer{};
  socklen_t size = sizeof(peer);
  if (Clock::now() >= deadline ||
      getsockopt(descriptor, SOL_SOCKET, SO_PEERCRED, &peer, &size) != 0 ||
      size != sizeof(peer) || peer.pid <= 0) return false;
  ProcessInstance first{};
  ProcessInstance second{};
  if (!ReadProcessInstance(peer.pid, deadline, &first)) return false;
  const std::string path = "/proc/" + std::to_string(peer.pid) + "/exe";
  char executable[4096];
  const ssize_t length = readlink(path.c_str(), executable, sizeof(executable) - 1);
  if (length <= 0 || length >= static_cast<ssize_t>(sizeof(executable) - 1) || Clock::now() >= deadline) return false;
  executable[length] = '\0';
  const char* basename = std::strrchr(executable, '/');
  // An Xwayland peer cannot prove the global foreground of its compositor.
  // Independent Xvnc and Xtigervnc are X11 desktops, subject to the same live capabilities.
  if (basename == nullptr || (std::strcmp(basename + 1, "Xorg") != 0 &&
      std::strcmp(basename + 1, "Xvnc") != 0 &&
      std::strcmp(basename + 1, "Xtigervnc") != 0) ||
      !ReadProcessInstance(peer.pid, deadline, &second) || !SameProcess(first, second)) return false;
  ucred confirmation{};
  size = sizeof(confirmation);
  if (Clock::now() >= deadline ||
      getsockopt(descriptor, SOL_SOCKET, SO_PEERCRED, &confirmation, &size) != 0 || size != sizeof(confirmation) ||
      confirmation.pid != peer.pid || confirmation.uid != peer.uid || confirmation.gid != peer.gid) return false;
  *identity = {first, peer.uid, peer.gid};
  return true;
}

class Connection {
 public:
  explicit Connection(Deadline deadline) : deadline_(deadline) {}
  ~Connection() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      complete_ = true;
    }
    completion_.notify_one();
    if (watchdog_.joinable()) watchdog_.join();
    if (watchdog_descriptor_ >= 0) close(watchdog_descriptor_);
    if (connection_ != nullptr) xcb_disconnect(connection_);
  }
  Connection(const Connection&) = delete;
  Connection& operator=(const Connection&) = delete;

  bool Open() {
    int display = 0;
    int screen = 0;
    if (!LocalDisplay(&display, &screen)) return false;
    Descriptor descriptor(ConnectLocal(display, deadline_));
    ServerPeer peer{};
    if (descriptor.get() < 0 || !NativeServer(descriptor.get(), deadline_, &peer)) return false;
    server_ = {peer, display, screen, XCB_NONE};
    watchdog_descriptor_ = fcntl(descriptor.get(), F_DUPFD_CLOEXEC, 0);
    if (watchdog_descriptor_ < 0) return false;
    // shutdown wakes libxcb's internal setup/flush waits too. The duplicate
    // keeps this socket identity stable even if setup closes its original FD.
    watchdog_ = std::thread([this] {
      std::unique_lock<std::mutex> lock(mutex_);
      if (!completion_.wait_until(lock, deadline_, [this] { return complete_; })) {
        expired_.store(true);
        shutdown(watchdog_descriptor_, SHUT_RDWR);
      }
    });
    Authority authority;
    if (!authority.Read(display, deadline_)) return false;
    connection_ = xcb_connect_to_fd(descriptor.release(), authority.get());
    if (!Healthy()) return false;
    const xcb_setup_t* setup = xcb_get_setup(connection_);
    if (setup == nullptr || setup->status != 1 || setup->protocol_major_version != 11) return false;
    auto roots = xcb_setup_roots_iterator(setup);
    while (screen-- > 0 && roots.rem > 0) xcb_screen_next(&roots);
    if (roots.rem == 0 || roots.data == nullptr || roots.data->root == XCB_NONE) return false;
    root_ = roots.data->root;
    server_.root = root_;
    const xcb_query_extension_reply_t* extension = xcb_get_extension_data(connection_, &xcb_res_id);
    if (extension == nullptr || extension->present == 0 || !Healthy()) return false;
    const auto version_cookie = xcb_res_query_version(connection_, 1, 2);
    const auto version = ReadReply<xcb_res_query_version_reply_t>(version_cookie.sequence);
    if (!version || version->server_major != 1 || version->server_minor < 2) return false;
    const auto* keyboard_extension = xcb_get_extension_data(connection_, &xcb_xkb_id);
    if (keyboard_extension == nullptr || keyboard_extension->present == 0 || !Healthy()) return false;
    const auto keyboard_cookie = xcb_xkb_use_extension(connection_, 1, 0);
    const auto keyboard = ReadReply<xcb_xkb_use_extension_reply_t>(keyboard_cookie.sequence);
    if (!keyboard || keyboard->supported == 0) return false;
    active_ = Atom("_NET_ACTIVE_WINDOW");
    supporting_ = Atom("_NET_SUPPORTING_WM_CHECK");
    supported_ = Atom("_NET_SUPPORTED");
    if (active_ == XCB_NONE || supporting_ == XCB_NONE || supported_ == XCB_NONE) return false;
    xcb_window_t manager = XCB_NONE;
    xcb_window_t confirmation = XCB_NONE;
    if (!WindowProperty(root_, supporting_, &manager) || manager == root_ ||
        !WindowProperty(manager, supporting_, &confirmation) || confirmation != manager) return false;
    const auto property_cookie = xcb_get_property(connection_, false, root_, supported_, XCB_ATOM_ATOM, 0, 1024);
    const auto property = ReadReply<xcb_get_property_reply_t>(property_cookie.sequence);
    if (!property || property->type != XCB_ATOM_ATOM || property->format != 32 ||
        property->bytes_after != 0 || property->value_len > 1024 ||
        xcb_get_property_value_length(property.get()) != static_cast<int>(property->value_len * sizeof(xcb_atom_t))) return false;
    const auto* atoms = static_cast<const xcb_atom_t*>(xcb_get_property_value(property.get()));
    ServerIdentity confirmation{};
    return std::find(atoms, atoms + property->value_len, active_) != atoms + property->value_len &&
        ReadServer(&confirmation) && SameServer(server_, confirmation);
  }

  bool Healthy() const {
    return connection_ != nullptr && Clock::now() < deadline_ && !expired_.load() &&
        xcb_connection_has_error(connection_) == 0;
  }
  bool TimedOut() const { return expired_.load() || Clock::now() >= deadline_; }
  xcb_connection_t* get() const { return connection_; }
  xcb_window_t root() const { return root_; }
  xcb_atom_t active_atom() const { return active_; }
  Deadline deadline() const { return deadline_; }

  bool ReadServer(ServerIdentity* identity, Deadline limit = Deadline::max()) const {
    ServerPeer observed{};
    if (!Healthy() || !NativeServer(watchdog_descriptor_, std::min(limit, deadline_), &observed) ||
        !SamePeer(server_.peer, observed) || !Healthy()) return false;
    *identity = {observed, server_.display, server_.screen, root_};
    return true;
  }

  template <typename T>
  Reply<T> ReadReply(unsigned int sequence, Deadline limit = Deadline::max()) {
    limit = std::min(limit, deadline_);
    if (!Healthy() || xcb_flush(connection_) <= 0) return {nullptr, &std::free};
    while (Healthy() && Clock::now() < limit) {
      void* result = nullptr;
      xcb_generic_error_t* error = nullptr;
      if (xcb_poll_for_reply(connection_, sequence, &result, &error) != 0) {
        const Reply<xcb_generic_error_t> owned_error(error, &std::free);
        Reply<T> reply(static_cast<T*>(result), &std::free);
        if (error != nullptr || !reply || !Healthy()) return {nullptr, &std::free};
        const auto* generic = reinterpret_cast<const xcb_generic_reply_t*>(reply.get());
        const std::size_t bytes = 32 + static_cast<std::size_t>(generic->length) * 4;
        if (generic->response_type != 1 || bytes < sizeof(T) || bytes > kMaximumReplyBytes) return {nullptr, &std::free};
        return reply;
      }
      if (!PollDescriptor(xcb_get_file_descriptor(connection_), POLLIN, limit)) break;
    }
    xcb_discard_reply(connection_, sequence);
    return {nullptr, &std::free};
  }

  bool Checked(xcb_void_cookie_t request) {
    const auto barrier_cookie = xcb_get_input_focus(connection_);
    const auto barrier = ReadReply<xcb_get_input_focus_reply_t>(barrier_cookie.sequence);
    if (!barrier) return false;
    // A later reply proves this checked void request can no longer receive a
    // new error; request_check therefore needs no additional blocking sync.
    const Reply<xcb_generic_error_t> error(xcb_request_check(connection_, request), &std::free);
    return !error && Healthy();
  }

  bool WindowProperty(xcb_window_t window, xcb_atom_t atom, xcb_window_t* value,
                      Deadline limit = Deadline::max()) {
    const auto cookie = xcb_get_property(connection_, false, window, atom, XCB_ATOM_WINDOW, 0, 1);
    const auto reply = ReadReply<xcb_get_property_reply_t>(cookie.sequence, limit);
    if (!reply || reply->type != XCB_ATOM_WINDOW || reply->format != 32 ||
        reply->value_len != 1 || reply->bytes_after != 0 || xcb_get_property_value_length(reply.get()) != 4) return false;
    std::memcpy(value, xcb_get_property_value(reply.get()), sizeof(*value));
    return *value != XCB_NONE;
  }

 private:
  xcb_atom_t Atom(const char* name) {
    const auto cookie = xcb_intern_atom(connection_, true, static_cast<std::uint16_t>(std::strlen(name)), name);
    const auto reply = ReadReply<xcb_intern_atom_reply_t>(cookie.sequence);
    return reply ? reply->atom : XCB_NONE;
  }

  Deadline deadline_;
  xcb_connection_t* connection_ = nullptr;
  ServerIdentity server_{};
  xcb_window_t root_ = XCB_NONE;
  xcb_atom_t active_ = XCB_NONE;
  xcb_atom_t supporting_ = XCB_NONE;
  xcb_atom_t supported_ = XCB_NONE;
  int watchdog_descriptor_ = -1;
  std::mutex mutex_;
  std::condition_variable completion_;
  std::thread watchdog_;
  std::atomic<bool> expired_{false};
  bool complete_ = false;
};

bool ReadOwner(Connection& connection, xcb_window_t window, ProcessInstance* process,
                Deadline limit = Deadline::max()) {
  if (window == XCB_NONE || window == connection.root() || !connection.Healthy()) return false;
  const auto ranges_cookie = xcb_res_query_clients(connection.get());
  const auto ranges = connection.ReadReply<xcb_res_query_clients_reply_t>(ranges_cookie.sequence, limit);
  if (!ranges || ranges->num_clients > 4096 || ranges->length != ranges->num_clients * 2 ||
      xcb_res_query_clients_clients_length(ranges.get()) != static_cast<int>(ranges->num_clients)) return false;
  xcb_window_t base = XCB_NONE;
  const auto* clients = xcb_res_query_clients_clients(ranges.get());
  for (std::uint32_t index = 0; index < ranges->num_clients; ++index) {
    if ((window & ~clients[index].resource_mask) == clients[index].resource_base) {
      if (base != XCB_NONE) return false;
      base = clients[index].resource_base;
    }
  }
  if (base == XCB_NONE) return false;
  const xcb_res_client_id_spec_t specification{window, XCB_RES_CLIENT_ID_MASK_LOCAL_CLIENT_PID};
  const auto cookie = xcb_res_query_client_ids(connection.get(), 1, &specification);
  const auto reply = connection.ReadReply<xcb_res_query_client_ids_reply_t>(cookie.sequence, limit);
  // Xorg returns clientAsMask (the resource base), not the input window XID.
  // LOCAL_CLIENT_PID has a four-byte wire length and exactly one CARD32 value.
  if (!reply || reply->num_ids != 1 || reply->length != 4) return false;
  const auto iterator = xcb_res_query_client_ids_ids_iterator(reply.get());
  if (iterator.rem != 1 || iterator.data == nullptr || iterator.data->spec.client != base ||
      iterator.data->spec.mask != XCB_RES_CLIENT_ID_MASK_LOCAL_CLIENT_PID || iterator.data->length != 4) return false;
  const std::uint32_t observed = *xcb_res_client_id_value_value(iterator.data);
  if (observed == 0 || observed > static_cast<std::uint32_t>(std::numeric_limits<pid_t>::max())) return false;
  return ReadProcessInstance(static_cast<pid_t>(observed), std::min(limit, connection.deadline()), process) &&
      connection.Healthy();
}

bool Viewable(Connection& connection, xcb_window_t window, Deadline limit = Deadline::max()) {
  const auto cookie = xcb_get_window_attributes(connection.get(), window);
  const auto reply = connection.ReadReply<xcb_get_window_attributes_reply_t>(cookie.sequence, limit);
  return reply && reply->_class == XCB_WINDOW_CLASS_INPUT_OUTPUT &&
      reply->map_state == XCB_MAP_STATE_VIEWABLE && connection.Healthy();
}

bool ConfirmTarget(napi_env environment, Connection& connection, const Target& target) {
  if (connection.TimedOut()) {
    Fail(environment, 10, "Targeted system input exceeded its deadline.");
    return false;
  }
  ServerIdentity server{};
  ProcessInstance observed{};
  if (!connection.ReadServer(&server) || !SameServer(server, target.server) ||
      !ReadOwner(connection, target.window, &observed) || !SameProcess(observed, target.client)) {
    Fail(environment, connection.TimedOut() ? 10 : 3,
         "The targeted system process identity is unavailable or changed.");
    return false;
  }
  if (observed.process == getpid()) {
    Fail(environment, 11, "Targeted system input requires an external process.");
    return false;
  }
  if (!Viewable(connection, target.window)) {
    Fail(environment, connection.TimedOut() ? 10 : 6, "The targeted system window is unavailable.");
    return false;
  }
  return true;
}

bool NextToken(Deadline deadline, std::uint64_t* token) {
  // All environments share one non-repeating sequence. A fresh process starts
  // with a private random epoch rather than restarting the published IDs at one.
  static std::atomic<std::uint64_t> last{0};
  std::uint64_t current = last.load();
  if (Clock::now() >= deadline) return false;
  if (current == 0) {
    std::uint64_t seed = 0;
    std::size_t received = 0;
    while (received < sizeof(seed) && Clock::now() < deadline) {
      const ssize_t amount = getrandom(reinterpret_cast<unsigned char*>(&seed) + received,
          sizeof(seed) - received, GRND_NONBLOCK);
      if (amount > 0) received += static_cast<std::size_t>(amount);
      else if (amount == 0 || errno != EINTR) return false;
    }
    if (received != sizeof(seed) || Clock::now() >= deadline) return false;
    seed &= static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max());
    if (seed == 0 || seed == static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) return false;
    if (last.compare_exchange_strong(current, seed)) current = seed;
  }
  while (Clock::now() < deadline && current < static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
    if (last.compare_exchange_weak(current, current + 1)) {
      *token = current + 1;
      return true;
    }
  }
  return false;
}

bool IssueTarget(TargetOwner& owner, const Target& target, Deadline deadline, std::uint64_t* token) {
  const auto existing = std::find_if(owner.targets.begin(), owner.targets.end(),
      [&target](const IssuedTarget& entry) { return SameTarget(entry.identity, target); });
  if (existing != owner.targets.end()) {
    *token = existing->token;
    return Clock::now() < deadline;
  }
  if (owner.targets.size() == kMaximumTargets) {
    for (auto entry = owner.targets.begin(); entry != owner.targets.end() && Clock::now() < deadline;) {
      ProcessInstance server{};
      ProcessInstance client{};
      bool valid = ReadProcessInstance(entry->identity.server.peer.instance.process, deadline, &server) &&
          SameProcess(server, entry->identity.server.peer.instance);
      if (Clock::now() >= deadline) return false;
      if (valid) valid = ReadProcessInstance(entry->identity.client.process, deadline, &client) &&
          SameProcess(client, entry->identity.client);
      if (Clock::now() >= deadline) return false;
      if (!valid) entry = owner.targets.erase(entry);
      else ++entry;
    }
  }
  // No TTL or live-target eviction: a long voice transaction retains its token.
  // A full table refuses new captures until an instance or effect retires one.
  if (Clock::now() >= deadline || owner.targets.size() >= kMaximumTargets || !NextToken(deadline, token)) return false;
  owner.targets.push_back({*token, target});
  return true;
}

bool ReadTargetArguments(napi_env environment, napi_callback_info information,
                         bool scroll, TargetOwner** owner, IssuedTarget* target, std::int32_t* wheel) {
  napi_value arguments[4];
  size_t count = scroll ? 4 : 3;
  void* data = nullptr;
  if (napi_get_cb_info(environment, information, &count, arguments, nullptr, &data) != napi_ok ||
      count != (scroll ? 3 : 2) || data == nullptr ||
      static_cast<TargetOwner*>(data)->environment != environment) {
    Fail(environment, 2, "Targeted system input received invalid arguments.", true);
    return false;
  }
  napi_valuetype identifier_type;
  napi_valuetype process_type;
  size_t length = 0;
  if (napi_typeof(environment, arguments[0], &identifier_type) != napi_ok || identifier_type != napi_string ||
      napi_get_value_string_utf8(environment, arguments[0], nullptr, 0, &length) != napi_ok ||
      length == 0 || length > 19 ||
      napi_typeof(environment, arguments[1], &process_type) != napi_ok || process_type != napi_number) {
    Fail(environment, 2, "Targeted system input requires an exact captured target and process identity.", true);
    return false;
  }
  char identifier[20];
  size_t copied = 0;
  if (napi_get_value_string_utf8(environment, arguments[0], identifier, sizeof(identifier), &copied) != napi_ok ||
      copied != length || identifier[0] < '1' || identifier[0] > '9') {
    Fail(environment, 2, "The targeted system window identity is invalid.", true);
    return false;
  }
  for (size_t index = 1; index < length; ++index) {
    if (identifier[index] < '0' || identifier[index] > '9') {
      Fail(environment, 2, "The targeted system window identity is invalid.", true);
      return false;
    }
  }
  std::uint64_t token = 0;
  const auto parsed = std::from_chars(identifier, identifier + length, token);
  double process = 0;
  if (parsed.ec != std::errc() || parsed.ptr != identifier + length ||
      token > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()) ||
      napi_get_value_double(environment, arguments[1], &process) != napi_ok || !std::isfinite(process) ||
      process <= 0 || process > std::numeric_limits<pid_t>::max() || std::floor(process) != process) {
    Fail(environment, 2, "The targeted system window or process identity is invalid.", true);
    return false;
  }
  *owner = static_cast<TargetOwner*>(data);
  const auto entry = std::find_if((*owner)->targets.begin(), (*owner)->targets.end(),
      [token](const IssuedTarget& value) { return value.token == token; });
  if (entry == (*owner)->targets.end() || entry->identity.client.process != static_cast<pid_t>(process)) {
    // A mismatched process cannot leave a previously issued target usable.
    RetireTarget(**owner, token);
    Fail(environment, 3, "The captured system target is unavailable or changed.");
    return false;
  }
  *target = *entry;
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

struct FixedKey {
  xcb_keycode_t code;
  std::uint16_t state;
};

bool FixedMapping(Connection& connection, xcb_keysym_t symbol, std::uint8_t modifiers, FixedKey* key) {
  const auto use_cookie = xcb_xkb_use_extension(connection.get(), 1, 0);
  const auto use = connection.ReadReply<xcb_xkb_use_extension_reply_t>(use_cookie.sequence);
  if (!use || use->supported == 0) return false;
  const auto flag = XCB_XKB_PER_CLIENT_FLAG_SEND_EVENT_USES_XKB_STATE;
  const auto flags_cookie = xcb_xkb_per_client_flags(connection.get(), XCB_XKB_ID_USE_CORE_KBD, flag, flag, 0, 0, 0);
  const auto flags = connection.ReadReply<xcb_xkb_per_client_flags_reply_t>(flags_cookie.sequence);
  if (!flags || (flags->supported & flag) == 0 || (flags->value & flag) == 0) return false;
  constexpr std::uint16_t parts = XCB_XKB_MAP_PART_KEY_TYPES | XCB_XKB_MAP_PART_KEY_SYMS;
  const auto cookie = xcb_xkb_get_map(connection.get(), XCB_XKB_ID_USE_CORE_KBD, parts,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  const auto reply = connection.ReadReply<xcb_xkb_get_map_reply_t>(cookie.sequence);
  if (!reply || reply->present != parts || reply->firstType != 0 || reply->nTypes == 0 ||
      reply->nKeySyms == 0 || reply->firstKeySym < reply->minKeyCode ||
      static_cast<unsigned int>(reply->firstKeySym) + reply->nKeySyms - 1 > reply->maxKeyCode) return false;
  const auto* cursor = static_cast<const unsigned char*>(xcb_xkb_get_map_map(reply.get()));
  const auto* end = reinterpret_cast<const unsigned char*>(reply.get()) + 32 + reply->length * 4;
  std::array<const xcb_xkb_key_type_t*, 256> types{};
  for (unsigned int index = 0; index < reply->nTypes; ++index) {
    if (cursor > end || static_cast<std::size_t>(end - cursor) < sizeof(xcb_xkb_key_type_t)) return false;
    const auto* type = reinterpret_cast<const xcb_xkb_key_type_t*>(cursor);
    const std::size_t bytes = sizeof(*type) + type->nMapEntries * sizeof(xcb_xkb_kt_map_entry_t) +
        (type->hasPreserve ? type->nMapEntries * sizeof(xcb_xkb_mod_def_t) : 0);
    if (type->hasPreserve > 1 || type->numLevels == 0 || bytes > static_cast<std::size_t>(end - cursor)) return false;
    types[index] = type;
    cursor += bytes;
  }
  bool found = false;
  std::uint32_t total_symbols = 0;
  for (unsigned int index = 0; index < reply->nKeySyms; ++index) {
    if (cursor > end || static_cast<std::size_t>(end - cursor) < sizeof(xcb_xkb_key_sym_map_t)) return false;
    const auto* map = reinterpret_cast<const xcb_xkb_key_sym_map_t*>(cursor);
    const std::size_t bytes = sizeof(*map) + map->nSyms * sizeof(xcb_keysym_t);
    if (bytes > static_cast<std::size_t>(end - cursor)) return false;
    const unsigned int groups = map->groupInfo & 0x0f;
    if (groups > 4 || (groups == 0 ? map->nSyms != 0 : map->width == 0 || map->nSyms != groups * map->width)) return false;
    const auto* symbols = xcb_xkb_key_sym_map_syms(map);
    for (unsigned int group = 0; group < groups; ++group) {
      const auto* type = types[map->kt_index[group]];
      if (type == nullptr || type->numLevels > map->width) return false;
      unsigned int level = 0;
      const std::uint8_t effective = modifiers & type->mods_mask;
      const auto* entries = xcb_xkb_key_type_map(type);
      bool selected = false;
      for (unsigned int entry = 0; entry < type->nMapEntries; ++entry) {
        if (entries[entry].active > 1 || entries[entry].level >= type->numLevels) return false;
        if (entries[entry].active != 0 && entries[entry].mods_mask == effective) {
          if (selected && level != entries[entry].level) return false;
          selected = true;
          level = entries[entry].level;
        }
      }
      if (!found && symbols[group * map->width + level] == symbol) {
        *key = {static_cast<xcb_keycode_t>(reply->firstKeySym + index),
                static_cast<std::uint16_t>(modifiers | (group << 13))};
        found = true;
      }
    }
    total_symbols += map->nSyms;
    cursor += bytes;
  }
  return found && cursor == end && total_symbols == reply->totalSyms && connection.Healthy();
}

bool FocusReceiver(Connection& connection, const Target& target, xcb_window_t* receiver,
                    Deadline limit = Deadline::max()) {
  ServerIdentity server{};
  if (!connection.ReadServer(&server, limit) || !SameServer(server, target.server)) return false;
  xcb_window_t active = XCB_NONE;
  if (!connection.WindowProperty(connection.root(), connection.active_atom(), &active, limit) || active != target.window) return false;
  const auto cookie = xcb_get_input_focus(connection.get());
  const auto focus = connection.ReadReply<xcb_get_input_focus_reply_t>(cookie.sequence, limit);
  if (!focus || focus->focus == XCB_NONE || focus->focus == XCB_INPUT_FOCUS_POINTER_ROOT) return false;
  const xcb_window_t candidate = focus->focus;
  xcb_window_t ancestor = candidate;
  bool belongs = false;
  for (unsigned int depth = 0; depth < 32; ++depth) {
    if (ancestor == target.window) { belongs = true; break; }
    if (ancestor == XCB_NONE || ancestor == connection.root()) break;
    const auto tree_cookie = xcb_query_tree(connection.get(), ancestor);
    const auto tree = connection.ReadReply<xcb_query_tree_reply_t>(tree_cookie.sequence, limit);
    if (!tree || tree->root != connection.root() || tree->parent == ancestor) return false;
    ancestor = tree->parent;
  }
  ProcessInstance process{};
  if (!belongs || !Viewable(connection, candidate, limit) ||
      !ReadOwner(connection, candidate, &process, limit) || !SameProcess(process, target.client) ||
      process.process == getpid()) return false;
  const auto second_cookie = xcb_get_input_focus(connection.get());
  const auto second = connection.ReadReply<xcb_get_input_focus_reply_t>(second_cookie.sequence, limit);
  ProcessInstance confirmation{};
  if (!second || second->focus != candidate ||
      !connection.WindowProperty(connection.root(), connection.active_atom(), &active, limit) || active != target.window ||
      !ReadOwner(connection, candidate, &confirmation, limit) || !SameProcess(confirmation, target.client) ||
      !connection.ReadServer(&server, limit) || !SameServer(server, target.server)) return false;
  *receiver = candidate;
  return connection.Healthy();
}

bool Activate(napi_env environment, Connection& connection, const Target& target, xcb_window_t* receiver) {
  if (FocusReceiver(connection, target, receiver)) return true;
  if (!ConfirmTarget(environment, connection, target)) return false;
  xcb_client_message_event_t message{};
  message.response_type = XCB_CLIENT_MESSAGE;
  message.format = 32;
  message.window = target.window;
  message.type = connection.active_atom();
  message.data.data32[0] = 1;
  // The HID callback has no X event timestamp; CurrentTime is explicit, and
  // the WM remains free to refuse activation. No focus is forced around it.
  message.data.data32[1] = XCB_CURRENT_TIME;
  const auto request = xcb_send_event_checked(connection.get(), false, connection.root(),
      XCB_EVENT_MASK_SUBSTRUCTURE_REDIRECT | XCB_EVENT_MASK_SUBSTRUCTURE_NOTIFY,
      reinterpret_cast<const char*>(&message));
  if (!connection.Checked(request)) {
    Fail(environment, connection.TimedOut() ? 10 : 4, "The targeted system window activation was refused.");
    return false;
  }
  const Deadline limit = std::min(connection.deadline(), Clock::now() + kActivationTimeout);
  while (connection.Healthy() && Clock::now() < limit) {
    if (FocusReceiver(connection, target, receiver, limit)) return true;
    std::this_thread::sleep_for(std::min(std::chrono::milliseconds(5),
        std::chrono::duration_cast<std::chrono::milliseconds>(limit - Clock::now())));
  }
  Fail(environment, connection.TimedOut() ? 10 : 4, "The targeted system paste focus was not granted.");
  return false;
}

bool SendKey(napi_env environment, Connection& connection, const Target& target,
             const FixedKey& key, xcb_window_t receiver, bool paste, bool pressed) {
  if (!ConfirmTarget(environment, connection, target)) return false;
  if (paste) {
    xcb_window_t focused = XCB_NONE;
    if (!FocusReceiver(connection, target, &focused) || focused != receiver) {
      Fail(environment, connection.TimedOut() ? 10 : 8, "The targeted system paste focus changed.");
      return false;
    }
  }
  xcb_key_press_event_t event{};
  event.response_type = pressed ? XCB_KEY_PRESS : XCB_KEY_RELEASE;
  event.detail = key.code;
  event.time = XCB_CURRENT_TIME;
  event.root = connection.root();
  event.event = receiver;
  event.same_screen = true;
  event.state = key.state;
  event.event_x = event.event_y = event.root_x = event.root_y = 1;
  // An empty mask addresses only the client that created this exact window.
  // The server marks this as a synthetic event; completion is not a consumer ACK.
  if (!connection.Healthy()) {
    Fail(environment, connection.TimedOut() ? 10 : 9, "The targeted system connection is unavailable.");
    return false;
  }
  const auto request = xcb_send_event_checked(connection.get(), false, receiver, XCB_EVENT_MASK_NO_EVENT,
      reinterpret_cast<const char*>(&event));
  if (!connection.Checked(request)) {
    Fail(environment, connection.TimedOut() ? 10 : pressed ? 4 : 5, "The targeted system key event was refused.");
    return false;
  }
  return true;
}

napi_value EffectComplete(napi_env environment) {
  napi_value result;
  if (napi_get_undefined(environment, &result) != napi_ok) {
    return Fail(environment, 12, "The targeted system input result could not be published.");
  }
  return result;
}

template <typename Action>
napi_value Safely(napi_env environment, Action action) {
  try { return action(); }
  catch (...) { return Fail(environment, 12, "The targeted system input could not complete."); }
}

napi_value PostKey(napi_env environment, napi_callback_info information, bool paste) {
  return Safely(environment, [&]() -> napi_value {
    TargetOwner* owner = nullptr;
    IssuedTarget issued{};
    if (!ReadTargetArguments(environment, information, false, &owner, &issued, nullptr)) return nullptr;
    EffectLease lease(*owner, issued.token);
    const Target& target = issued.identity;
    Connection connection(Clock::now() + kEffectTimeout);
    if (!connection.Open()) return Fail(environment, connection.TimedOut() ? 10 : 9, "Native X11 system input is unavailable.");
    if (!ConfirmTarget(environment, connection, target)) return nullptr;
    FixedKey key{};
    if (!FixedMapping(connection, paste ? kPasteKey : kReturn, paste ? XCB_MOD_MASK_CONTROL : 0, &key)) {
      return Fail(environment, connection.TimedOut() ? 10 : 7, "The fixed system key mapping is unavailable.");
    }
    xcb_window_t receiver = target.window;
    if (paste && !Activate(environment, connection, target, &receiver)) return nullptr;
    if (!SendKey(environment, connection, target, key, receiver, paste, true) ||
        !SendKey(environment, connection, target, key, receiver, paste, false)) return nullptr;
    napi_value result = EffectComplete(environment);
    if (result != nullptr) lease.Complete();
    return result;
  });
}

napi_value PostReturn(napi_env environment, napi_callback_info information) {
  return PostKey(environment, information, false);
}

napi_value PostPaste(napi_env environment, napi_callback_info information) {
  return PostKey(environment, information, true);
}

napi_value PostScroll(napi_env environment, napi_callback_info information) {
  return Safely(environment, [&]() -> napi_value {
    TargetOwner* owner = nullptr;
    IssuedTarget issued{};
    std::int32_t amount = 0;
    if (!ReadTargetArguments(environment, information, true, &owner, &issued, &amount)) return nullptr;
    EffectLease lease(*owner, issued.token);
    const Target& target = issued.identity;
    Connection connection(Clock::now() + kEffectTimeout);
    if (!connection.Open()) return Fail(environment, connection.TimedOut() ? 10 : 9, "Native X11 system input is unavailable.");
    if (!ConfirmTarget(environment, connection, target)) return nullptr;
    const int repeats = std::clamp(static_cast<int>(std::abs(std::floor(amount / 40.0 + 0.5))), 1, 20);
    const std::uint8_t button = amount > 0 ? 4 : 5;
    for (int index = 0; index < repeats; ++index) {
      for (const bool pressed : {true, false}) {
        const auto pointer_cookie = xcb_query_pointer(connection.get(), target.window);
        const auto pointer = connection.ReadReply<xcb_query_pointer_reply_t>(pointer_cookie.sequence);
        if (!pointer || pointer->root != connection.root() || pointer->same_screen == 0) {
          return Fail(environment, connection.TimedOut() ? 10 : 6, "The targeted system scroll position is unavailable.");
        }
        if (!ConfirmTarget(environment, connection, target)) return nullptr;
        xcb_button_press_event_t event{};
        event.response_type = pressed ? XCB_BUTTON_PRESS : XCB_BUTTON_RELEASE;
        event.detail = button;
        event.root = connection.root();
        event.event = target.window;
        event.time = XCB_CURRENT_TIME;
        event.same_screen = true;
        event.child = pointer->child;
        event.event_x = pointer->win_x;
        event.event_y = pointer->win_y;
        event.root_x = pointer->root_x;
        event.root_y = pointer->root_y;
        event.state = pressed ? 0 : button == 4 ? XCB_BUTTON_MASK_4 : XCB_BUTTON_MASK_5;
        if (!connection.Healthy()) {
          return Fail(environment, connection.TimedOut() ? 10 : 9, "The targeted system connection is unavailable.");
        }
        const auto request = xcb_send_event_checked(connection.get(), false, target.window, XCB_EVENT_MASK_NO_EVENT,
            reinterpret_cast<const char*>(&event));
        if (!connection.Checked(request)) {
          return Fail(environment, connection.TimedOut() ? 10 : 5, "The targeted system scroll event was refused.");
        }
      }
    }
    napi_value result = EffectComplete(environment);
    if (result != nullptr) lease.Complete();
    return result;
  });
}

napi_value CaptureTarget(napi_env environment, napi_callback_info information) {
  return Safely(environment, [&]() -> napi_value {
    size_t count = 1;
    napi_value argument;
    void* data = nullptr;
    if (napi_get_cb_info(environment, information, &count, &argument, nullptr, &data) != napi_ok || count != 0 ||
        data == nullptr || static_cast<TargetOwner*>(data)->environment != environment) {
      return Fail(environment, 2, "System frontmost capture takes no arguments.", true);
    }
    Connection connection(Clock::now() + kCaptureTimeout);
    if (!connection.Open()) return Fail(environment, connection.TimedOut() ? 10 : 9, "Native X11 foreground capture is unavailable.");
    Target first{};
    Target second{};
    xcb_window_t final_window = XCB_NONE;
    if (!connection.ReadServer(&first.server) ||
        !connection.WindowProperty(connection.root(), connection.active_atom(), &first.window) ||
        !Viewable(connection, first.window) || !ReadOwner(connection, first.window, &first.client) ||
        !connection.ReadServer(&second.server) ||
        !connection.WindowProperty(connection.root(), connection.active_atom(), &second.window) ||
        !Viewable(connection, second.window) || !ReadOwner(connection, second.window, &second.client) ||
        !SameTarget(first, second) ||
        !connection.WindowProperty(connection.root(), connection.active_atom(), &final_window) || final_window != first.window) {
      return Fail(environment, connection.TimedOut() ? 10 : 3, "The system frontmost target identity is unavailable or changed.");
    }
    ServerIdentity final_server{};
    if (!connection.ReadServer(&final_server) || !SameServer(final_server, first.server)) {
      return Fail(environment, connection.TimedOut() ? 10 : 3, "The system frontmost server identity is unavailable or changed.");
    }
    if (first.client.process == getpid()) return Fail(environment, 11, "System frontmost capture requires an external process.");
    std::uint64_t token = 0;
    auto& owner = *static_cast<TargetOwner*>(data);
    if (!IssueTarget(owner, first, connection.deadline(), &token)) {
      return Fail(environment, connection.TimedOut() ? 10 : 12, "The captured system target could not be retained.");
    }
    char native_id[20];
    const auto converted = std::to_chars(native_id, native_id + sizeof(native_id), token);
    napi_value target;
    napi_value identifier;
    napi_value process;
    if (converted.ec != std::errc() || napi_create_object(environment, &target) != napi_ok ||
        napi_create_string_utf8(environment, native_id, converted.ptr - native_id, &identifier) != napi_ok ||
        napi_create_int32(environment, first.client.process, &process) != napi_ok ||
        napi_set_named_property(environment, target, "nativeId", identifier) != napi_ok ||
        napi_set_named_property(environment, target, "processId", process) != napi_ok) {
      RetireTarget(owner, token);
      return Fail(environment, 12, "The system frontmost target could not be published.");
    }
    return target;
  });
}

void DestroyOwner(void* data) {
  delete static_cast<TargetOwner*>(data);
}

}  // namespace

NAPI_MODULE_INIT() {
  return Safely(env, [&]() -> napi_value {
    auto owned = std::make_unique<TargetOwner>(env);
    if (napi_add_env_cleanup_hook(env, DestroyOwner, owned.get()) != napi_ok) {
      return Fail(env, 12, "The system frontmost native owner could not initialize.");
    }
    TargetOwner* owner = owned.release();
    napi_value version;
    napi_value capture;
    napi_value post_return;
    napi_value post_scroll;
    napi_value post_paste;
    // Loading only defines the contract; the physical callback owns live reads.
    if (napi_create_uint32(env, 1, &version) != napi_ok ||
        napi_create_function(env, "captureTarget", NAPI_AUTO_LENGTH, CaptureTarget, owner, &capture) != napi_ok ||
        napi_create_function(env, "postReturn", NAPI_AUTO_LENGTH, PostReturn, owner, &post_return) != napi_ok ||
        napi_create_function(env, "postScroll", NAPI_AUTO_LENGTH, PostScroll, owner, &post_scroll) != napi_ok ||
        napi_create_function(env, "postPaste", NAPI_AUTO_LENGTH, PostPaste, owner, &post_paste) != napi_ok ||
        napi_set_named_property(env, exports, "protocolVersion", version) != napi_ok ||
        napi_set_named_property(env, exports, "captureTarget", capture) != napi_ok ||
        napi_set_named_property(env, exports, "postReturn", post_return) != napi_ok ||
        napi_set_named_property(env, exports, "postScroll", post_scroll) != napi_ok ||
        napi_set_named_property(env, exports, "postPaste", post_paste) != napi_ok) {
      return Fail(env, 12, "The system frontmost native module could not initialize.");
    }
    return exports;
  });
}
