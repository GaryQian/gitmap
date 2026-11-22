#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// One playable item of the catalog.
@interface Track : NSObject <NSCopying>

@property (nonatomic, copy, readonly) NSString *title;
@property (nonatomic, readonly) NSTimeInterval duration;
@property (nonatomic, copy, nullable) NSURL *audioURL;

- (instancetype)initWithTitle:(NSString *)title duration:(NSTimeInterval)duration;
+ (nullable instancetype)trackWithDictionary:(NSDictionary<NSString *, id> *)dictionary;
- (BOOL)isLongerThan:(Track *)other;

@end

NS_ASSUME_NONNULL_END
