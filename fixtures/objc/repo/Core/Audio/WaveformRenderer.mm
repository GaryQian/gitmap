#import "WaveformRenderer.h"
#import "Track.h"

#include <vector>
#include "PeakAnalyzer.hpp"

const NSUInteger kWaveformBuckets = 64;

namespace {

std::vector<float> SamplesForTrack(Track *track) {
    // A real build decodes track.audioURL; the fixture synthesises a ramp.
    std::vector<float> samples(static_cast<std::size_t>(track.duration * 100));
    for (std::size_t i = 0; i < samples.size(); ++i) samples[i] = static_cast<float>(i % 50) / 50.0f;
    return samples;
}

}  // namespace

@implementation WaveformRenderer {
    audio::PeakAnalyzer *_analyzer;
}

- (instancetype)initWithBucketCount:(NSUInteger)bucketCount {
    self = [super init];
    if (self) {
        _analyzer = new audio::PeakAnalyzer(bucketCount);
    }
    return self;
}

- (void)dealloc {
    delete _analyzer;
}

- (NSArray<NSNumber *> *)peaksForTrack:(Track *)track {
    std::vector<float> peaks = _analyzer->computePeaks(SamplesForTrack(track));
    audio::normalizePeaks(peaks);
    NSMutableArray<NSNumber *> *result = [NSMutableArray arrayWithCapacity:peaks.size()];
    for (float peak : peaks) {
        [result addObject:@(peak)];
    }
    return result;
}

@end
