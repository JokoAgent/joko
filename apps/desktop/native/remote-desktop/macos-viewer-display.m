#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <math.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

// Development-only CoreGraphics SPI. Unsupported systems keep ordinary displays.
@interface NSObject (JokoVirtualDisplay)
- (id)initWithDescriptor:(id)descriptor;
- (id)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)rate;
- (BOOL)applySettings:(id)settings;
- (unsigned int)displayID;
@end

static id display;
static CGDirectDisplayID sourceDisplay;
static CGDisplayModeRef sourceMode;

static void cleanup(void) {
  if (sourceDisplay && CGDisplayIsOnline(sourceDisplay)) {
    CGDisplayConfigRef config;
    if (CGBeginDisplayConfiguration(&config) == kCGErrorSuccess) {
      CGConfigureDisplayMirrorOfDisplay(config, sourceDisplay, kCGNullDirectDisplay);
      if (sourceMode) CGConfigureDisplayWithDisplayMode(config, sourceDisplay, sourceMode, NULL);
      CGCompleteDisplayConfiguration(config, kCGConfigureForSession);
    }
  }
  display = nil;
  if (sourceMode) CGDisplayModeRelease(sourceMode);
  sourceMode = NULL;
  sourceDisplay = 0;
}
static void emit(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}
static BOOL available(void) {
  return NSClassFromString(@"CGVirtualDisplay") && NSClassFromString(@"CGVirtualDisplayDescriptor") &&
    NSClassFromString(@"CGVirtualDisplaySettings") && NSClassFromString(@"CGVirtualDisplayMode");
}
static BOOL dimension(id value) {
  if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
  double number = [value doubleValue];
  return isfinite(number) && number == floor(number) && number >= 320 && number <= 2560;
}
static BOOL setSize(unsigned int width, unsigned int height) {
  if (!display) {
    id descriptor = [NSClassFromString(@"CGVirtualDisplayDescriptor") new];
    [descriptor setValue:@"Joko Remote Desktop" forKey:@"name"];
    [descriptor setValue:@(4096) forKey:@"maxPixelsWide"];
    [descriptor setValue:@(4096) forKey:@"maxPixelsHigh"];
    [descriptor setValue:@(0x4a4f) forKey:@"vendorID"];
    [descriptor setValue:@(1) forKey:@"productID"];
    [descriptor setValue:@(getpid()) forKey:@"serialNum"];
    if ([descriptor respondsToSelector:NSSelectorFromString(@"setSerialNumber:")])
      [descriptor setValue:@(getpid()) forKey:@"serialNumber"];
    [descriptor setValue:dispatch_get_main_queue() forKey:@"queue"];
    [descriptor setValue:[NSValue valueWithSize:NSMakeSize(300, 300)] forKey:@"sizeInMillimeters"];
    display = [[NSClassFromString(@"CGVirtualDisplay") alloc] initWithDescriptor:descriptor];
    if (!display) return NO;
  }
  id mode = [[NSClassFromString(@"CGVirtualDisplayMode") alloc] initWithWidth:width height:height refreshRate:60];
  id settings = [NSClassFromString(@"CGVirtualDisplaySettings") new];
  [settings setValue:@0 forKey:@"hiDPI"];
  [settings setValue:@[mode] forKey:@"modes"];
  return [display applySettings:settings];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--probe") == 0) {
      emit(@{@"available": @(available())});
      return available() ? 0 : 2;
    }
    if (!available()) return 2;
    signal(SIGTERM, SIG_IGN);
    signal(SIGINT, SIG_IGN);
    dispatch_source_t termination = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(termination, ^{ cleanup(); exit(0); });
    dispatch_resume(termination);
    dispatch_source_t interrupt = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(interrupt, ^{ cleanup(); exit(0); });
    dispatch_resume(interrupt);
    // The owning process retains one source and one temporary mirror. EOF releases both.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      char line[4097];
      while (fgets(line, sizeof(line), stdin)) {
        size_t length = strlen(line);
        if (!length || line[length - 1] != '\n') break;
        NSData *data = [NSData dataWithBytes:line length:length];
        NSDictionary *command = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        dispatch_sync(dispatch_get_main_queue(), ^{
          @try {
            if (![command isKindOfClass:NSDictionary.class] || command.count != 3 || !dimension(command[@"width"]) || !dimension(command[@"height"])) {
              emit(@{@"error": @"INVALID_REQUEST"}); return;
            }
            NSString *sourceText = command[@"sourceDisplayId"];
            if (![sourceText isKindOfClass:NSString.class] || !sourceText.length || sourceText.length > 10 || [sourceText characterAtIndex:0] == '0' ||
              [sourceText rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789"] invertedSet]].location != NSNotFound) {
              emit(@{@"error": @"DISPLAY_SOURCE_UNAVAILABLE"}); return;
            }
            long long sourceNumber = sourceText.longLongValue;
            if (sourceNumber <= 0 || sourceNumber > UINT32_MAX) { emit(@{@"error": @"DISPLAY_SOURCE_UNAVAILABLE"}); return; }
            unsigned int source = (unsigned int)sourceNumber;
            if (!sourceDisplay) {
              if (!CGDisplayIsOnline(source) || CGDisplayIsInMirrorSet(source)) { emit(@{@"error": @"DISPLAY_SOURCE_UNAVAILABLE"}); return; }
              sourceMode = CGDisplayCopyDisplayMode(source);
              if (!sourceMode) { emit(@{@"error": @"DISPLAY_SOURCE_UNAVAILABLE"}); return; }
              sourceDisplay = source;
            } else if (source != sourceDisplay) { emit(@{@"error": @"DISPLAY_SOURCE_UNAVAILABLE"}); return; }
            unsigned int width = [command[@"width"] unsignedIntValue], height = [command[@"height"] unsignedIntValue];
            if (!setSize(width, height)) { emit(@{@"error": @"DISPLAY_SIZE_FAILED"}); return; }
            CGDisplayConfigRef config;
            if (CGBeginDisplayConfiguration(&config) != kCGErrorSuccess) { emit(@{@"error": @"DISPLAY_MIRROR_FAILED"}); return; }
            if (CGConfigureDisplayMirrorOfDisplay(config, sourceDisplay, [display displayID]) != kCGErrorSuccess) {
              CGCancelDisplayConfiguration(config); emit(@{@"error": @"DISPLAY_MIRROR_FAILED"}); return;
            }
            if (CGCompleteDisplayConfiguration(config, kCGConfigureForSession) != kCGErrorSuccess) { emit(@{@"error": @"DISPLAY_MIRROR_FAILED"}); return; }
            CGRect bounds = CGDisplayBounds([display displayID]);
            emit(@{@"id": @([display displayID]), @"width": @(width), @"height": @(height),
              @"logicalWidth": @(bounds.size.width), @"logicalHeight": @(bounds.size.height)});
          } @catch (NSException *exception) { emit(@{@"error": @"DISPLAY_UNAVAILABLE"}); }
        });
      }
      dispatch_async(dispatch_get_main_queue(), ^{ cleanup(); exit(0); });
    });
    dispatch_main();
  }
}
