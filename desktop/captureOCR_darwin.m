#import <Foundation/Foundation.h>
#import <Vision/Vision.h>

char *ThalocaRecognizeCaptureText(const char *path) {
    @autoreleasepool {
        if (@available(macOS 10.15, *)) {
        NSString *value = [NSString stringWithUTF8String:path];
        NSURL *url = value ? [NSURL fileURLWithPath:value] : nil;
        if (!url) return strdup("ERROR:invalid image path");
        __block NSMutableArray<NSString *> *lines = [NSMutableArray array];
        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] initWithCompletionHandler:^(VNRequest *req, NSError *error) {
            if (error) return;
            for (VNRecognizedTextObservation *observation in req.results) {
                VNRecognizedText *candidate = [[observation topCandidates:1] firstObject];
                if (candidate.string.length) [lines addObject:candidate.string];
            }
        }];
        request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        request.usesLanguageCorrection = YES;
        NSError *error = nil;
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithURL:url options:@{}];
        BOOL ok = [handler performRequests:@[request] error:&error];
        NSString *result = ok ? [lines componentsJoinedByString:@"\n"] : [@"ERROR:" stringByAppendingString:error.localizedDescription ?: @"OCR failed"];
        [handler release]; [request release];
        return strdup(result.UTF8String ?: "");
        }
        return strdup("ERROR:OCR requires macOS 10.15 or newer");
    }
}
