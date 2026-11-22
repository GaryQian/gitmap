#import <Foundation/Foundation.h>

typedef void (^NKCompletion)(NSArray<NSDictionary *> * _Nullable items, NSError * _Nullable error);

/// A small JSON-over-HTTP client.
@interface NKClient : NSObject

+ (void)setDefaultBaseURL:(NSURL *)baseURL;
- (void)getPath:(NSString *)path completion:(NKCompletion)completion;

@end
