#import "PlayerViewController.h"
#import "Track.h"
#import "Track+Formatting.h"
#import "WaveformRenderer.h"

@interface PlayerViewController ()
@property (nonatomic, strong) TrackStore *store;
@property (nonatomic, strong) WaveformRenderer *renderer;
@property (nonatomic, strong) UILabel *titleLabel;
@end

@implementation PlayerViewController

- (instancetype)initWithStore:(TrackStore *)store {
    self = [super initWithNibName:nil bundle:nil];
    if (self) {
        _store = store;
        _store.delegate = self;
        _renderer = [[WaveformRenderer alloc] initWithBucketCount:kWaveformBuckets];
    }
    return self;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.titleLabel = [[UILabel alloc] initWithFrame:CGRectZero];
    [self.view addSubview:self.titleLabel];
    [self selectTrack:[self.store trackAtIndex:0]];
}

/// Puts a track on screen and logs how many peaks its waveform has.
- (void)selectTrack:(Track *)track {
    if (track == nil) return;
    // The label reads "Title (m:ss)"; [track displayTitle] comes from Track+Formatting.
    self.titleLabel.text = [track displayTitle];
    NSArray<NSNumber *> *peaks = [self.renderer peaksForTrack:track];
    NSLog(@"[player] %@ has %lu peaks", [track formattedDuration], (unsigned long)peaks.count);
}

#pragma mark - TrackStoreDelegate

- (void)trackStore:(TrackStore *)store didLoadTracks:(NSArray<Track *> *)tracks {
    [self selectTrack:tracks.firstObject];
}

- (void)trackStore:(TrackStore *)store didFailWithError:(NSError *)error {
    self.titleLabel.text = error.localizedDescription;
}

@end
