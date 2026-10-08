#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreImage/CoreImage.h>
#import <IOSurface/IOSurface.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#import <dlfcn.h>
#import <signal.h>
#import <stdatomic.h>
#import <stdlib.h>
#import <time.h>
#import <unistd.h>

static _Atomic(time_t) lastRequest;

// Compatibility capture for an already logged-in macOS session. The public
// legacy symbols are unavailable at compile time in current SDKs, so resolve
// them explicitly and fail closed if the OS removes them. This helper opens no
// socket, changes no TCC setting and performs no elevation.
typedef void (^FrameHandler)(int32_t, uint64_t, IOSurfaceRef, const void *);
typedef CFTypeRef (*CreateStream)(CGDirectDisplayID, size_t, size_t, int32_t,
                                 CFDictionaryRef, dispatch_queue_t, FrameHandler);
typedef CGError (*StartStream)(CFTypeRef);

static BOOL ownedLoggedInSession(void) {
  NSDictionary *state = CFBridgingRelease(CGSessionCopyCurrentDictionary());
  NSNumber *uid = state[(__bridge NSString *)kCGSessionUserIDKey];
  NSNumber *console = state[(__bridge NSString *)kCGSessionOnConsoleKey];
  NSNumber *loginDone = state[(__bridge NSString *)kCGSessionLoginDoneKey];
  NSNumber *locked = state[@"CGSSessionScreenIsLocked"];
  return state != nil && uid != nil && uid.unsignedIntValue == geteuid()
    && console.boolValue && loginDone.boolValue && locked != nil;
}

static NSDictionary *readCursor(CGDirectDisplayID display) {
  typedef boolean_t (*CursorVisible)(void);
  CursorVisible visible = (CursorVisible)dlsym(RTLD_DEFAULT, "CGCursorIsVisible");
  if (!visible) return nil;
  NSCursor *cursor = [NSCursor currentSystemCursor];
  if (!cursor) return nil;
  NSImage *image = cursor.image;
  NSSize size = image.size;
  if (size.width <= 0 || size.height <= 0 || size.width > 256 || size.height > 256) return nil;
  CGImageRef cg = [image CGImageForProposedRect:NULL context:nil hints:nil];
  if (!cg || CGImageGetWidth(cg) > 512 || CGImageGetHeight(cg) > 512) return nil;
  NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:cg];
  NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  if (!png || png.length < 1 || png.length > 49152) return nil;
  CGEventRef event = CGEventCreate(NULL);
  if (!event) return nil;
  CGPoint point = CGEventGetLocation(event);
  CFRelease(event);
  CGRect bounds = CGDisplayBounds(display);
  if (bounds.size.width <= 0 || bounds.size.height <= 0) return nil;
  NSPoint hot = cursor.hotSpot;
  return @{
    @"visible": visible() && CGRectContainsPoint(bounds, point) ? @YES : @NO,
    @"x": @(fmax(0, fmin(1, (point.x - bounds.origin.x) / bounds.size.width))),
    @"y": @(fmax(0, fmin(1, (point.y - bounds.origin.y) / bounds.size.height))),
    @"width": @(size.width),
    @"height": @(size.height),
    @"hotX": @(fmax(0, fmin(size.width, hot.x))),
    @"hotY": @(fmax(0, fmin(size.height, hot.y))),
    @"png": [png base64EncodedStringWithOptions:0]
  };
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    // Stream: <display> <native-video|cursor-overlay> <fps> <quality>
    //         <physical max edge, 0 = logical> <max JPEG bytes>
    BOOL nativeVideo = argc == 7 &&
      (strcmp(argv[2], "native-video") == 0 || strcmp(argv[2], "cursor-overlay") == 0);
    BOOL overlay = nativeVideo && strcmp(argv[2], "cursor-overlay") == 0;
    if ((argc != 2 && !nativeVideo) || !ownedLoggedInSession()) return 2;
    int fps = 15;
    double quality = 0.55;
    long physicalMaxEdge = 0;
    long frameLimit = 180000;
    if (nativeVideo) {
      if (strcmp(argv[3], "30") == 0) fps = 30;
      else if (strcmp(argv[3], "60") == 0) fps = 60;
      else return 2;
      char *qualityEnd = NULL;
      quality = strtod(argv[4], &qualityEnd);
      if (!*argv[4] || *qualityEnd || quality < 0.1 || quality > 1) return 2;
      char *physicalEnd = NULL;
      physicalMaxEdge = strtol(argv[5], &physicalEnd, 10);
      char *frameEnd = NULL;
      frameLimit = strtol(argv[6], &frameEnd, 10);
      if (!*argv[5] || *physicalEnd || physicalMaxEdge < 0 || physicalMaxEdge > 8192
          || !*argv[6] || *frameEnd || frameLimit < 100000 || frameLimit > 4000000) return 2;
    }
    char *end = NULL;
    unsigned long value = strtoul(argv[1], &end, 10);
    if (!*argv[1] || *end || value > UINT32_MAX || !CGDisplayIsOnline((uint32_t)value)) return 2;
    if (!CGPreflightScreenCaptureAccess()) return 3;

    // A sleeping display may start a stream without producing pixels. Wake the
    // display without changing lock or authentication state; Main owns the
    // finite authenticated viewer lease and its display-sleep blocker.
    IOPMAssertionID activity = kIOPMNullAssertionID;
    IOPMAssertionDeclareUserActivity(CFSTR("Joko remote desktop viewer"),
                                     kIOPMUserActiveLocal, &activity);
    CreateStream create = (CreateStream)dlsym(RTLD_DEFAULT,
      "CGDisplayStreamCreateWithDispatchQueue");
    StartStream start = (StartStream)dlsym(RTLD_DEFAULT, "CGDisplayStreamStart");
    const CFStringRef *intervalKey = dlsym(RTLD_DEFAULT,
      "kCGDisplayStreamMinimumFrameTime");
    const CFStringRef *cursorKey = dlsym(RTLD_DEFAULT, "kCGDisplayStreamShowCursor");
    if (!create || !start || !intervalKey || !cursorKey) return 4;

    CGDirectDisplayID display = (uint32_t)value;
    size_t width = CGDisplayPixelsWide(display), height = CGDisplayPixelsHigh(display);
    if (!width || !height) return 2;
    // Every native stream is cursor-free. Cursor-overlay mode reports the
    // independently bounded current shape/location; compatibility fallback
    // reports null and never bakes an un-fenceable stale cursor into pixels.
    // Native WebRTC video may use backing pixels under a tier-owned long-edge
    // target. Compatibility fallback stays at the inexpensive 1280-pixel bound.
    BOOL separateCursor = overlay;
    double edgeLimit = nativeVideo ? 4096.0 : 1280.0;
    if (nativeVideo && physicalMaxEdge) {
      CGDisplayModeRef mode = CGDisplayCopyDisplayMode(display);
      if (mode) {
        size_t pixelWidth = CGDisplayModeGetPixelWidth(mode);
        size_t pixelHeight = CGDisplayModeGetPixelHeight(mode);
        CGDisplayModeRelease(mode);
        if (pixelWidth > width && pixelHeight > height) {
          width = pixelWidth;
          height = pixelHeight;
        }
      }
      double logicalEdge = (double)MAX(CGDisplayPixelsWide(display), CGDisplayPixelsHigh(display));
      edgeLimit = MAX((double)physicalMaxEdge, MIN(edgeLimit, logicalEdge));
    }
    double scale = MIN(1.0, edgeLimit / MAX(width, height));
    width = MAX(1, (size_t)(width * scale));
    height = MAX(1, (size_t)(height * scale));
    dispatch_queue_t queue = dispatch_queue_create("joko.desktop.capture", DISPATCH_QUEUE_SERIAL);
    CIContext *context = [CIContext contextWithOptions:@{ kCIContextCacheIntermediates: @NO }];
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    __block NSData *latest = nil;
    __block size_t latestWidth = 0;
    __block size_t latestHeight = 0;
    __block BOOL requested = NO;
    atomic_store(&lastRequest, time(NULL));

    void (^reply)(void) = ^{
      if (!requested || !latest) return;
      requested = NO;
      __block NSDictionary *cursor = nil;
      if (separateCursor) {
        dispatch_sync(dispatch_get_main_queue(), ^{ cursor = readCursor(display); });
      }
      NSDictionary *frame = @{
        @"jpeg": [latest base64EncodedStringWithOptions:0],
        @"width": @(latestWidth),
        @"height": @(latestHeight),
        @"cursor": cursor ?: [NSNull null]
      };
      NSMutableData *line = [[NSJSONSerialization dataWithJSONObject:frame options:0 error:NULL]
        mutableCopy];
      if (!line) _exit(5);
      [line appendBytes:"\n" length:1];
      const uint8_t *bytes = line.bytes;
      size_t remaining = line.length;
      while (remaining) {
        ssize_t count = write(STDOUT_FILENO, bytes, remaining);
        if (count <= 0) _exit(0);
        bytes += count;
        remaining -= count;
      }
    };

    CFTypeRef stream = create(display, width, height, 'BGRA',
      (__bridge CFDictionaryRef)@{
        (__bridge NSString *)*intervalKey: @(1.0 / fps),
        (__bridge NSString *)*cursorKey: @NO
      }, queue, ^(int32_t status, uint64_t timestamp, IOSurfaceRef surface, const void *update) {
        @autoreleasepool {
          if (status == 3) _exit(5);
          if (status == 2) {
            latest = nil;
            latestWidth = latestHeight = 0;
            return;
          }
          if (status != 0 || !surface) return;
          CIImage *image = [CIImage imageWithIOSurface:surface];
          NSData *jpeg = [context JPEGRepresentationOfImage:image colorSpace:color
            options:@{ (__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @(quality) }];
          NSUInteger limit = (NSUInteger)frameLimit;
          if (jpeg.length > limit) {
            for (NSNumber *q in @[@0.45, @0.25, @0.1]) {
              if (jpeg.length <= limit) break;
              jpeg = [context JPEGRepresentationOfImage:image colorSpace:color
                options:@{ (__bridge NSString *)kCGImageDestinationLossyCompressionQuality: q }];
            }
            for (int attempt = 0; jpeg.length > limit && attempt < 4; attempt++) {
              image = [image imageByApplyingTransform:CGAffineTransformMakeScale(0.75, 0.75)];
              jpeg = [context JPEGRepresentationOfImage:image colorSpace:color
                options:@{ (__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @0.25 }];
            }
          }
          if (jpeg.length < 1 || jpeg.length > limit) {
            latest = nil;
            latestWidth = latestHeight = 0;
          } else {
            CGRect extent = image.extent;
            latest = jpeg;
            latestWidth = MAX(1, (size_t)llround(extent.size.width));
            latestHeight = MAX(1, (size_t)llround(extent.size.height));
          }
          reply();
        }
      });
    if (!stream || start(stream) != kCGErrorSuccess) return 5;
    signal(SIGPIPE, SIG_IGN);

    // stdin is a private parent pipe: one byte requests the newest frame. EOF,
    // a session-owner change, or a stalled parent retires the child without
    // retaining pixels.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      char byte;
      while (read(STDIN_FILENO, &byte, 1) == 1) {
        if (byte != 'f' || !ownedLoggedInSession()) _exit(2);
        atomic_store(&lastRequest, time(NULL));
        dispatch_async(queue, ^{ requested = YES; reply(); });
      }
      _exit(0);
    });
    dispatch_source_t watchdog = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
      dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    dispatch_source_set_timer(watchdog, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC),
      NSEC_PER_SEC, 0);
    dispatch_source_set_event_handler(watchdog, ^{
      if (time(NULL) - atomic_load(&lastRequest) > 5 || !ownedLoggedInSession()) _exit(0);
    });
    dispatch_resume(watchdog);
    dispatch_main();
  }
}
