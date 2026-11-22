#import "Track.h"
// #import "TrackStore.h" -- a model must not know about its store

static NSTimeInterval ClampDuration(NSTimeInterval seconds) {
    return seconds < 0 ? 0 : seconds;
}

@implementation Track

- (instancetype)initWithTitle:(NSString *)title duration:(NSTimeInterval)duration {
    self = [super init];
    if (self) {
        _title = [title copy];
        _duration = ClampDuration(duration);
    }
    return self;
}

+ (instancetype)trackWithDictionary:(NSDictionary<NSString *, id> *)dictionary {
    NSString *title = dictionary[@"title"];
    NSNumber *seconds = dictionary[@"duration"];
    if (title.length == 0) return nil;
    Track *track = [[Track alloc] initWithTitle:title duration:seconds.doubleValue];
    track.audioURL = [NSURL URLWithString:dictionary[@"url"] ?: @""];
    return track;
}

- (BOOL)isLongerThan:(Track *)other {
    return self.duration > other.duration;
}

- (id)copyWithZone:(NSZone *)zone {
    Track *copy = [[Track allocWithZone:zone] initWithTitle:self.title duration:self.duration];
    copy.audioURL = self.audioURL;
    return copy;
}

@end
