#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN
/// Geometry belongs to this attached view's window, in local points.
@interface JokoWindowGeometry : UIView
@property(nonatomic, copy, nullable) void (^onChange)(NSDictionary *geometry);
@end
NS_ASSUME_NONNULL_END
