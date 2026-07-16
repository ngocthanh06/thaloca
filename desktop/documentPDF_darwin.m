#import <Foundation/Foundation.h>
#import <PDFKit/PDFKit.h>

char *ThalocaExtractPDFPages(const char *path) {
    @autoreleasepool {
        NSString *pathString = [NSString stringWithUTF8String:path];
        PDFDocument *document = pathString
            ? [[PDFDocument alloc] initWithURL:[NSURL fileURLWithPath:pathString]]
            : nil;
        NSMutableDictionary *result = [NSMutableDictionary dictionary];
        if (!document) {
            result[@"error"] = @"PDFKit could not open the document";
        } else {
            NSMutableArray *pages = [NSMutableArray arrayWithCapacity:document.pageCount];
            for (NSInteger i = 0; i < document.pageCount; i++) {
                [pages addObject:[[document pageAtIndex:i] string] ?: @""];
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
