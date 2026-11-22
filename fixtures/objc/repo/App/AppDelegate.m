#import "AppDelegate.h"
#import "PlayerViewController.h"
#import "Store/TrackStore.h"

@import UIKit;
@import NetKit;

static NSString * const kCatalogHost = @"https://catalog.example.com";

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    [NKClient setDefaultBaseURL:[NSURL URLWithString:kCatalogHost]];

    TrackStore *store = [TrackStore sharedStore];
    PlayerViewController *player = [[PlayerViewController alloc] initWithStore:store];

    self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
    self.window.rootViewController = player;
    [self.window makeKeyAndVisible];
    [store refresh];
    return YES;
}

@end
