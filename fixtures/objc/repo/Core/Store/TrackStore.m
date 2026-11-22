#import "TrackStore.h"
#import "Models/Track.h"
#import <NetKit/NKClient.h>

@interface TrackStore ()
@property (nonatomic, strong) NSMutableArray<Track *> *tracks;
@property (nonatomic, strong) NKClient *client;
@end

@implementation TrackStore

+ (instancetype)sharedStore {
    static TrackStore *shared;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        shared = [[TrackStore alloc] init];
    });
    return shared;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _tracks = [NSMutableArray array];
        _client = [[NKClient alloc] init];
    }
    return self;
}

- (NSUInteger)count {
    return self.tracks.count;
}

- (void)refresh {
    __weak typeof(self) weakSelf = self;
    [self.client getPath:@"/tracks" completion:^(NSArray<NSDictionary *> *items, NSError *error) {
        if (error != nil) {
            [weakSelf reportError:error];
            return;
        }
        for (NSDictionary *item in items) {
            Track *track = [Track trackWithDictionary:item];
            if (track != nil) [weakSelf addTrack:track];
        }
        [weakSelf.delegate trackStore:weakSelf didLoadTracks:[weakSelf.tracks copy]];
    }];
}

- (void)addTrack:(Track *)track {
    [self.tracks addObject:track];
}

- (Track *)trackAtIndex:(NSUInteger)index {
    return index < self.tracks.count ? self.tracks[index] : nil;
}

- (void)reportError:(NSError *)error {
    if ([self.delegate respondsToSelector:@selector(trackStore:didFailWithError:)]) {
        [self.delegate trackStore:self didFailWithError:error];
    }
}

@end
