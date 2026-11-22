#import "NKClient.h"

static NSURL *gDefaultBaseURL;

@implementation NKClient

+ (void)setDefaultBaseURL:(NSURL *)baseURL {
    gDefaultBaseURL = baseURL;
}

- (void)getPath:(NSString *)path completion:(NKCompletion)completion {
    NSURL *url = [NSURL URLWithString:path relativeToURL:gDefaultBaseURL];
    NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithURL:url completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error != nil) {
            completion(nil, error);
            return;
        }
        NSArray *items = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
        completion(items, error);
    }];
    [task resume];
}

@end
