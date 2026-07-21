#import <Foundation/Foundation.h>
#import <PDFKit/PDFKit.h>
#import <Vision/Vision.h>

// renderPageImage rasterizes a PDF page at 2x its point size (roughly
// 144 DPI) — plain PDFKit text extraction misses image-only pages (e.g. a
// full-page website screenshot saved as PDF), so this is only used as an
// OCR fallback for those, same recognizer as Captures' "Extract text (OCR)".
static NSImage *renderPageImage(PDFPage *page) {
    NSRect bounds = [page boundsForBox:kPDFDisplayBoxMediaBox];
    CGFloat scale = 2.0;
    NSSize size = NSMakeSize(bounds.size.width * scale, bounds.size.height * scale);
    if (size.width <= 0 || size.height <= 0) return nil;
    return [page thumbnailOfSize:size forBox:kPDFDisplayBoxMediaBox];
}

static NSString *ocrPageImage(NSImage *image) {
    if (@available(macOS 10.15, *)) {
        CGImageRef cgImage = [image CGImageForProposedRect:NULL context:nil hints:nil];
        if (!cgImage) return @"";
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
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:cgImage options:@{}];
        BOOL ok = [handler performRequests:@[request] error:&error];
        NSString *result = ok ? [lines componentsJoinedByString:@"\n"] : @"";
        [handler release];
        [request release];
        return result;
    }
    return @"";
}

char *ThalocaExtractPDFPages(const char *path, int maxPages, int enableOCR) {
    @autoreleasepool {
        NSString *pathString = [NSString stringWithUTF8String:path];
        PDFDocument *document = pathString
            ? [[PDFDocument alloc] initWithURL:[NSURL fileURLWithPath:pathString]]
            : nil;
        NSMutableDictionary *result = [NSMutableDictionary dictionary];
        if (!document) {
            result[@"error"] = @"PDFKit could not open the document";
        } else if (maxPages > 0 && document.pageCount > maxPages) {
            result[@"error"] = [NSString stringWithFormat:@"PDF exceeds the %d page automatic indexing limit", maxPages];
        } else {
            NSMutableArray *pages = [NSMutableArray arrayWithCapacity:document.pageCount];
            for (NSInteger i = 0; i < document.pageCount; i++) {
                PDFPage *page = [document pageAtIndex:i];
                NSString *text = [page string] ?: @"";
                BOOL hasText = [[text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] length] > 0;
                if (!hasText && enableOCR) {
                    NSImage *rendered = renderPageImage(page);
                    if (rendered) text = ocrPageImage(rendered);
                }
                [pages addObject:text ?: @""];
            }
            result[@"pages"] = pages;
        }
        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        NSString *jsonString = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        char *response = jsonString ? strdup([jsonString UTF8String]) : NULL;
        [jsonString release];
        [document release];
        return response;
    }
}
