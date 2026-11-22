#import <Foundation/Foundation.h>

@class Track;
@class TrackStore;

@protocol TrackStoreDelegate <NSObject>
- (void)trackStore:(TrackStore *)store didLoadTracks:(NSArray<Track *> *)tracks;
@optional
- (void)trackStore:(TrackStore *)store didFailWithError:(NSError *)error;
@end

/// Keeps the catalog in memory and reloads it from the network.
@interface TrackStore : NSObject

@property (nonatomic, weak) id<TrackStoreDelegate> delegate;
@property (nonatomic, readonly) NSUInteger count;

+ (instancetype)sharedStore;
- (void)refresh;
- (void)addTrack:(Track *)track;
- (Track *)trackAtIndex:(NSUInteger)index;

@end
