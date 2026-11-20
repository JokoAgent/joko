#import <AppKit/AppKit.h>
#include <node_api.h>
#include <atomic>
#include <cstring>
#include <memory>
#include <string>

struct DeliveryState {
  std::atomic_bool overflowed{false};
  bool reportedOverflow = false;
};

static void Deliver(napi_env env, napi_value callback, void *context, void *data) {
  std::unique_ptr<std::string> frame(static_cast<std::string *>(data));
  if (!env || !callback) return;
  auto state = static_cast<DeliveryState *>(context);
  if (state->overflowed) {
    if (state->reportedOverflow) return;
    state->reportedOverflow = true;
    *frame = R"({"phase":"cancel","touches":[]})";
  }
  napi_value receiver, argument;
  napi_get_undefined(env, &receiver);
  if (napi_create_string_utf8(env, frame->data(), frame->size(), &argument) == napi_ok) {
    napi_call_function(env, receiver, callback, 1, &argument, nullptr);
  }
}

@interface JokoTrackpadCapture : NSObject
@property(nonatomic, weak) NSWindow *window;
@property(nonatomic, weak) NSView *view;
@property(nonatomic, strong) id eventMonitor;
@property(nonatomic, strong) id resignObserver;
@property(nonatomic, strong) NSMutableDictionary *identifiers;
@property(nonatomic, strong) id device;
@property(nonatomic) napi_threadsafe_function callback;
@property(nonatomic) DeliveryState *delivery;
@property(nonatomic) uint32_t serial;
@property(nonatomic) BOOL tracking;
@property(nonatomic) BOOL waitingForLift;
@property(nonatomic) BOOL suppressGestures;
@property(nonatomic) BOOL previousRestingTouches;
- (void)stop;
- (NSEvent *)handleEvent:(NSEvent *)event;
@end

static JokoTrackpadCapture *capture;
static uint32_t lastSerial;

static BOOL IsCurrent(NSWindow *window, NSView *view) {
  return window && view && NSApp.isActive && window.isKeyWindow && window.firstResponder == view && view.window == window;
}

static BOOL PointerHitsView(NSWindow *window, NSView *view) {
  NSView *root = window.contentView;
  NSPoint pointer = [root convertPoint:window.mouseLocationOutsideOfEventStream fromView:nil];
  NSView *hit = [root hitTest:pointer];
  return hit == view || [hit isDescendantOf:view];
}

@implementation JokoTrackpadCapture
- (BOOL)emit:(NSDictionary *)packet {
  NSData *json = [NSJSONSerialization dataWithJSONObject:packet options:0 error:nullptr];
  if (!self.callback || !json) return NO;
  auto frame = std::make_unique<std::string>(static_cast<const char *>(json.bytes), json.length);
  if (napi_call_threadsafe_function(self.callback, frame.get(), napi_tsfn_nonblocking) != napi_ok) {
    self.delivery->overflowed = true;
    return NO;
  }
  frame.release();
  return YES;
}

- (void)cancelGesture {
  BOOL hadGesture = self.tracking;
  self.tracking = NO;
  self.suppressGestures = NO;
  if (hadGesture && ![self emit:@{@"phase": @"cancel", @"touches": @[]}]) [self stop];
}

- (void)stop {
  if (!self.callback) return;
  if (self.tracking) [self emit:@{@"phase": @"cancel", @"touches": @[]}];
  self.tracking = NO;
  self.suppressGestures = NO;
  if (self.eventMonitor) {
    self.view.wantsRestingTouches = self.previousRestingTouches;
    [NSEvent removeMonitor:self.eventMonitor];
  }
  if (self.resignObserver) [[NSNotificationCenter defaultCenter] removeObserver:self.resignObserver];
  self.eventMonitor = nil;
  self.resignObserver = nil;
  self.device = nil;
  napi_release_threadsafe_function(self.callback, napi_tsfn_release);
  self.callback = nullptr;
  self.delivery = nullptr;
}

- (void)handleContacts:(NSEvent *)event {
  NSSet<NSTouch *> *sample = [event touchesMatchingPhase:NSTouchPhaseAny inView:self.view];
  if (!sample.count) return;
  NSMutableArray<NSTouch *> *active = [NSMutableArray array];
  BOOL cancelled = NO;
  for (NSTouch *touch in sample) {
    if (touch.type != NSTouchTypeIndirect) continue;
    if (touch.phase == NSTouchPhaseCancelled) cancelled = YES;
    if (touch.phase & NSTouchPhaseTouching) [active addObject:touch];
  }
  if (self.waitingForLift) {
    self.waitingForLift = active.count != 0;
    return;
  }
  if (cancelled || active.count > 2) {
    self.waitingForLift = active.count != 0;
    [self cancelGesture];
    return;
  }
  BOOL beginning = !self.tracking;
  if (beginning) {
    if (active.count != 2) {
      if (active.count == 1) self.suppressGestures = NO;
      return;
    }
    if ([NSEvent pressedMouseButtons] || !PointerHitsView(self.window, self.view)) {
      self.waitingForLift = YES;
      return;
    }
    [self.identifiers removeAllObjects];
    self.device = active.firstObject.device;
    self.tracking = YES;
    self.suppressGestures = YES;
  }
  NSMutableArray *points = [NSMutableArray array];
  NSSize size = NSZeroSize;
  for (NSTouch *touch in active) {
    NSNumber *identifier = self.identifiers[touch.identity];
    BOOL differentDevice = touch.device != self.device && ![touch.device isEqual:self.device];
    if (differentDevice || (!identifier && self.identifiers.count == 2)) {
      self.waitingForLift = YES;
      [self cancelGesture];
      return;
    }
    if (!identifier) {
      identifier = @(self.identifiers.count);
      self.identifiers[touch.identity] = identifier;
    }
    NSPoint normalized = touch.normalizedPosition;
    size = touch.deviceSize;
    [points addObject:@{@"id": identifier, @"x": @(normalized.x), @"y": @(1 - normalized.y)}];
  }
  if (!active.count) self.tracking = NO;
  NSString *phase = beginning ? @"begin" : active.count ? @"change" : @"end";
  if (![self emit:@{@"phase": phase, @"touches": points, @"width": @(size.width), @"height": @(size.height)}]) [self stop];
}

- (NSEvent *)handleEvent:(NSEvent *)event {
  if (!IsCurrent(self.window, self.view)) {
    [self stop];
    return event;
  }
  if (event.window != self.window) return event;
  switch (event.type) {
    case NSEventTypeGesture:
      [self handleContacts:event];
      break;
    case NSEventTypeScrollWheel:
      if (!self.tracking && event.phase == NSEventPhaseBegan) self.suppressGestures = NO;
      if (self.suppressGestures && (event.phase != NSEventPhaseNone || event.momentumPhase != NSEventPhaseNone)) {
        if (event.momentumPhase & (NSEventPhaseEnded | NSEventPhaseCancelled)) self.suppressGestures = NO;
        return nil;
      }
      break;
    case NSEventTypeMagnify:
    case NSEventTypeRotate:
      if (self.suppressGestures) return nil;
      break;
    case NSEventTypeLeftMouseDown:
    case NSEventTypeRightMouseDown:
      if (self.tracking) self.waitingForLift = YES;
      [self cancelGesture];
      break;
    default:
      break;
  }
  return event;
}
@end

static NSWindow *WindowForHandle(napi_env env, napi_value input) {
  void *bytes = nullptr;
  size_t size = 0;
  if (![NSThread isMainThread] || napi_get_buffer_info(env, input, &bytes, &size) != napi_ok || size != sizeof(void *)) return nil;
  void *address;
  memcpy(&address, bytes, sizeof(address));
  NSView *view = (__bridge NSView *)address;
  return view.window;
}

static napi_value Start(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], result;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  napi_get_null(env, &result);
  napi_valuetype type;
  if (count != 2 || napi_typeof(env, args[1], &type) != napi_ok || type != napi_function) return result;
  NSWindow *window = WindowForHandle(env, args[0]);
  NSResponder *responder = window.firstResponder;
  NSView *view = [responder isKindOfClass:NSView.class] ? (NSView *)responder : nil;
  if (!IsCurrent(window, view) || !PointerHitsView(window, view)) return result;

  napi_value label;
  napi_create_string_utf8(env, "JokoTrackpad", NAPI_AUTO_LENGTH, &label);
  napi_threadsafe_function callback;
  auto delivery = std::make_unique<DeliveryState>();
  if (napi_create_threadsafe_function(env, args[1], nullptr, label, 64, 1, delivery.get(),
      [](napi_env, void *state, void *) { delete static_cast<DeliveryState *>(state); }, delivery.get(), Deliver, &callback) != napi_ok) return result;
  napi_unref_threadsafe_function(env, callback);

  [capture stop];
  JokoTrackpadCapture *next = [JokoTrackpadCapture new];
  capture = next;
  next.callback = callback;
  next.delivery = delivery.release();
  next.serial = ++lastSerial;
  next.window = window;
  next.view = view;
  next.identifiers = [NSMutableDictionary dictionary];
  next.previousRestingTouches = view.wantsRestingTouches;
  view.wantsRestingTouches = YES;
  __weak JokoTrackpadCapture *weak = next;
  next.eventMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:
      NSEventMaskGesture | NSEventMaskMagnify | NSEventMaskRotate | NSEventMaskScrollWheel |
      NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown handler:^NSEvent *(NSEvent *event) {
    JokoTrackpadCapture *current = weak;
    return current ? [current handleEvent:event] : event;
  }];
  if (!next.eventMonitor) {
    view.wantsRestingTouches = next.previousRestingTouches;
    [next stop];
    capture = nil;
    return result;
  }
  next.resignObserver = [[NSNotificationCenter defaultCenter] addObserverForName:NSWindowDidResignKeyNotification
      object:window queue:nil usingBlock:^(NSNotification *) { [weak stop]; }];
  napi_create_uint32(env, next.serial, &result);
  return result;
}

static napi_value Stop(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value input, result;
  uint32_t serial;
  napi_get_cb_info(env, info, &count, &input, nullptr, nullptr);
  if ([NSThread isMainThread] && count == 1 && napi_get_value_uint32(env, input, &serial) == napi_ok && capture.serial == serial) {
    [capture stop];
    capture = nil;
  }
  napi_get_undefined(env, &result);
  return result;
}

static napi_value Position(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value input, result;
  napi_get_cb_info(env, info, &count, &input, nullptr, nullptr);
  NSWindow *window = count == 1 ? WindowForHandle(env, input) : nil;
  NSView *view = window.contentView;
  if (!view || !window.isKeyWindow || !NSApp.isActive) {
    napi_get_null(env, &result);
    return result;
  }
  NSPoint point = [view convertPoint:window.mouseLocationOutsideOfEventStream fromView:nil];
  napi_value x, y;
  napi_create_object(env, &result);
  napi_create_double(env, point.x - NSMinX(view.bounds), &x);
  napi_create_double(env, view.isFlipped ? point.y - NSMinY(view.bounds) : NSMaxY(view.bounds) - point.y, &y);
  napi_set_named_property(env, result, "x", x);
  napi_set_named_property(env, result, "y", y);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value version;
  napi_create_uint32(env, 1, &version);
  napi_set_named_property(env, exports, "protocolVersion", version);
  napi_property_descriptor methods[] = {
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default_jsproperty, nullptr},
    {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default_jsproperty, nullptr},
    {"position", nullptr, Position, nullptr, nullptr, nullptr, napi_default_jsproperty, nullptr}
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  napi_add_env_cleanup_hook(env, [](void *) { if ([NSThread isMainThread]) { [capture stop]; capture = nil; } }, nullptr);
  return exports;
}
