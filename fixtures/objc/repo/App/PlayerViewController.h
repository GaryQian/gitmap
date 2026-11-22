#import <UIKit/UIKit.h>
#import "TrackStore.h"

@class Track;

/// Shows the selected track's title and the peaks of its waveform.
@interface PlayerViewController : UIViewController <TrackStoreDelegate>

- (instancetype)initWithStore:(TrackStore *)store;
- (void)selectTrack:(Track *)track;

@end
