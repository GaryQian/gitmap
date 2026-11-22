#import "Track+Formatting.h"

@implementation Track (Formatting)

- (NSString *)formattedDuration {
    NSInteger total = (NSInteger)round(self.duration);
    return [NSString stringWithFormat:@"%ld:%02ld", (long)(total / 60), (long)(total % 60)];
}

- (NSString *)displayTitle {
    return [NSString stringWithFormat:@"%@ (%@)", self.title, [self formattedDuration]];
}

@end
