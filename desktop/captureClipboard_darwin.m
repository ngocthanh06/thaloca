#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

char *ThalocaCopyCapture(const char *path, int asImage) {
    @autoreleasepool {
        NSString *value = [NSString stringWithUTF8String:path];
        if (!value) return strdup("invalid capture path");
        NSPasteboard *board = [NSPasteboard generalPasteboard];
        [board clearContents];
        BOOL ok = NO;
        if (asImage) {
            NSImage *image = [[NSImage alloc] initWithContentsOfFile:value];
            if (!image) return strdup("capture is not a readable image");
            ok = [board writeObjects:@[image]];
            [image release];
        } else {
            ok = [board writeObjects:@[[NSURL fileURLWithPath:value]]];
        }
        return ok ? NULL : strdup("macOS could not write the capture to the clipboard");
    }
}
