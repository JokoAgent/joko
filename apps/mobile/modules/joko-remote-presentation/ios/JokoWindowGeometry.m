#import "JokoWindowGeometry.h"
#import <math.h>

#if __has_include(<UIKit/UIViewReservedRegion.h>) && __has_include(<UIKit/UIVerticalBarEdge.h>)
#define JOKO_RESERVED_REGIONS 1
#else
#define JOKO_RESERVED_REGIONS 0
#endif

@interface JokoWindowGeometry (Observation)
- (void)publishGeometry;
@end
/// The display link retains this target, which does not retain the observed view.
@interface JokoGeometryTick : NSObject
@property(nonatomic, weak) JokoWindowGeometry *view;
- (void)tick;
@end
@implementation JokoGeometryTick
- (void)tick { [self.view publishGeometry]; }
@end

@implementation JokoWindowGeometry {
  CADisplayLink *_displayLink;
  NSDictionary *_lastGeometry;
}
- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    self.userInteractionEnabled = NO;
    self.accessibilityElementsHidden = YES;
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(stopObserving)
      name:UIApplicationDidEnterBackgroundNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(startObserving)
      name:UIApplicationDidBecomeActiveNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(sceneChanged:)
      name:UISceneDidActivateNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(sceneChanged:)
      name:UISceneWillDeactivateNotification object:nil];
  }
  return self;
}
- (void)dealloc {
  [_displayLink invalidate];
  [NSNotificationCenter.defaultCenter removeObserver:self];
}
- (void)didMoveToWindow {
  [super didMoveToWindow];
  [self stopObserving];
  _lastGeometry = nil;
  [self startObserving];
}
- (void)sceneChanged:(NSNotification *)notification {
  if (notification.object != self.window.windowScene) return;
  if ([notification.name isEqualToString:UISceneWillDeactivateNotification]) [self stopObserving];
  else [self startObserving];
}
- (void)stopObserving { [_displayLink invalidate]; _displayLink = nil; }
- (void)startObserving {
  if (!self.window || self.window.windowScene.activationState != UISceneActivationStateForegroundActive
      || UIApplication.sharedApplication.applicationState != UIApplicationStateActive) return;
  [self publishGeometry];
#if JOKO_RESERVED_REGIONS
  if (@available(iOS 27.1, *)) {
    // Hardware reservations can move without changing bounds or size classes.
    if (!_displayLink) {
      JokoGeometryTick *target = [JokoGeometryTick new];
      target.view = self;
      _displayLink = [CADisplayLink displayLinkWithTarget:target selector:@selector(tick)];
      _displayLink.preferredFrameRateRange = CAFrameRateRangeMake(5, 10, 10);
      [_displayLink addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    }
  }
#endif
}
- (void)layoutSubviews { [super layoutSubviews]; [self publishGeometry]; }
- (void)safeAreaInsetsDidChange { [super safeAreaInsetsDidChange]; [self publishGeometry]; }
- (void)traitCollectionDidChange:(UITraitCollection *)previous {
  [super traitCollectionDidChange:previous];
  [self publishGeometry];
}
- (void)publishGeometry {
  if (!self.window || self.window.windowScene.activationState != UISceneActivationStateForegroundActive
      || UIApplication.sharedApplication.applicationState != UIApplicationStateActive || CGRectIsEmpty(self.bounds)) return;
  CGFloat width = self.bounds.size.width, height = self.bounds.size.height;
  UIEdgeInsets safe = self.safeAreaInsets;
  if (!isfinite(width) || !isfinite(height) || width <= 0 || height <= 0
      || !isfinite(safe.top) || !isfinite(safe.right) || !isfinite(safe.bottom) || !isfinite(safe.left)
      || safe.top < 0 || safe.right < 0 || safe.bottom < 0 || safe.left < 0) return;
  NSMutableArray *regions = [NSMutableArray array];
  NSString *edge = @"none";
  BOOL supported = NO;
#if JOKO_RESERVED_REGIONS
  if (@available(iOS 27.1, *)) {
    supported = YES;
    // Hardware-relative leading/trailing edges are independent of RTL content.
    switch (self.traitCollection.verticalBarEdge) {
      case UIVerticalBarEdgeLeading: edge = @"left"; break;
      case UIVerticalBarEdgeTrailing: edge = @"right"; break;
      default: break;
    }
    NSArray *kinds = @[UIViewReservedRegionKind.divisionRegionKind, UIViewReservedRegionKind.occlusionRegionKind];
    for (NSUInteger i = 0; i < kinds.count; i++) {
      for (UIViewReservedRegion *region in [self reservedRegionsOfKind:kinds[i]]) {
        CGRect rect = CGRectIntersection(self.bounds, region.frame);
        if (CGRectIsNull(rect) || CGRectIsEmpty(rect) || !isfinite(rect.origin.x) || !isfinite(rect.origin.y)
            || !isfinite(rect.size.width) || !isfinite(rect.size.height)) continue;
        [regions addObject:@{@"kind": i == 0 ? @"division" : @"occlusion",
          @"x": @(rect.origin.x), @"y": @(rect.origin.y),
          @"width": @(rect.size.width), @"height": @(rect.size.height)}];
      }
    }
  }
#endif
  NSDictionary *geometry = @{
    @"width": @(width), @"height": @(height),
    @"insets": @{@"top": @(safe.top), @"right": @(safe.right), @"bottom": @(safe.bottom), @"left": @(safe.left)},
    @"regularWidth": @(self.traitCollection.horizontalSizeClass == UIUserInterfaceSizeClassRegular),
    @"regularHeight": @(self.traitCollection.verticalSizeClass == UIUserInterfaceSizeClassRegular),
    @"barEdge": edge, @"regions": regions, @"reservedRegionsSupported": @(supported)
  };
  if ([_lastGeometry isEqualToDictionary:geometry]) return;
  _lastGeometry = geometry;
  if (self.onChange) self.onChange(geometry);
}
@end
