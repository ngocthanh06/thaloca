#import <Cocoa/Cocoa.h>

@interface ThalocaMenuBarController : NSObject
+ (void)install;
- (void)openThaloca:(id)sender;
- (void)quitThaloca:(id)sender;
@end

static NSStatusItem *thalocaStatusItem;
static ThalocaMenuBarController *thalocaMenuBarController;
static NSWindow *thalocaMainWindow;

@implementation ThalocaMenuBarController

+ (void)install {
    if (thalocaStatusItem != nil) {
        return;
    }

    thalocaMenuBarController = [[ThalocaMenuBarController alloc] init];
    thalocaMainWindow = [[NSApp mainWindow] retain];
    thalocaStatusItem = [[[NSStatusBar systemStatusBar]
        statusItemWithLength:NSVariableStatusItemLength] retain];
    thalocaStatusItem.autosaveName = @"com.wails.thaloca.statusItem";

    NSStatusBarButton *button = thalocaStatusItem.button;
    button.toolTip = @"Thaloca";
    // A template SF Symbol renders narrower and more consistently with
    // every other menu bar extra than a plain text title — on a notched
    // MacBook, where total menu bar width is already reduced, every extra
    // point of width increases the odds of landing in (or right against)
    // the notch's cutout. This isn't a fix for that placement itself:
    // AppKit gives third-party apps no public API to request a specific
    // status item position — the system lays every app's items out based
    // on registration order and available space, same as it does for
    // every other menu bar app. autosaveName above is what actually helps
    // long-term: once the user Cmd-drags this item to a clear spot once,
    // macOS remembers that position across future launches.
    if (@available(macOS 11.0, *)) {
        NSImage *icon = [NSImage imageWithSystemSymbolName:@"square.grid.2x2.fill" accessibilityDescription:@"Thaloca"];
        icon.template = YES;
        button.image = icon;
        button.title = @"";
    } else {
        button.image = nil;
        button.title = @"T";
    }

    NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Thaloca"];
    NSMenuItem *openItem = [[NSMenuItem alloc]
        initWithTitle:@"Open Thaloca"
               action:@selector(openThaloca:)
        keyEquivalent:@""];
    openItem.target = thalocaMenuBarController;
    [menu addItem:openItem];
    [openItem release];

    [menu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *quitItem = [[NSMenuItem alloc]
        initWithTitle:@"Quit Thaloca"
               action:@selector(quitThaloca:)
        keyEquivalent:@"q"];
    quitItem.target = thalocaMenuBarController;
    [menu addItem:quitItem];
    [quitItem release];

    thalocaStatusItem.menu = menu;
    [menu release];
}

- (void)openThaloca:(id)sender {
    if (thalocaMainWindow == nil) {
        for (NSWindow *window in NSApp.windows) {
            if (window.canBecomeMainWindow) {
                thalocaMainWindow = [window retain];
                break;
            }
        }
    }
    [thalocaMainWindow makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)quitThaloca:(id)sender {
    [NSApp terminate:nil];
}

@end

void ThalocaInstallMenuBar(void) {
    // This must share Wails' existing Cocoa run loop. A previous third-party
    // systray implementation started its own main-thread loop and caused a
    // reproducible SIGTRAP when the two loops competed.
    [ThalocaMenuBarController performSelectorOnMainThread:@selector(install)
                                                withObject:nil
                                             waitUntilDone:NO];
}
