#import "Track.h"

@interface Track (Formatting)

/// "m:ss", for example 3:07.
- (NSString *)formattedDuration;
/// "Title (m:ss)".
- (NSString *)displayTitle;

@end
