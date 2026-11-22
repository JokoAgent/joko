#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface JokoSpeakerOnnxSession : NSObject
+ (nullable instancetype)loadModelAtPath:(NSString *)path NS_SWIFT_NAME(load(modelPath:));
- (nullable NSDictionary<NSString *, NSDictionary<NSString *, id> *> *)
    runWithNames:(NSArray<NSString *> *)names
      dimensions:(NSArray<NSArray<NSNumber *> *> *)dimensions
           bytes:(NSData *)bytes NS_SWIFT_NAME(run(names:dimensions:bytes:));
@end

NS_ASSUME_NONNULL_END
