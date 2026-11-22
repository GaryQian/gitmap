#import <Foundation/Foundation.h>

@class Track;

extern const NSUInteger kWaveformBuckets;

/// Turns a track's samples into the peak list the player draws.
@interface WaveformRenderer : NSObject

- (instancetype)initWithBucketCount:(NSUInteger)bucketCount;
- (NSArray<NSNumber *> *)peaksForTrack:(Track *)track;

@end
