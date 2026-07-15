#import <Cocoa/Cocoa.h>

long long ThalocaPasteboardChangeCount(void) {
    return (long long)[[NSPasteboard generalPasteboard] changeCount];
}
