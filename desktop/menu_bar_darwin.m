#import <Cocoa/Cocoa.h>
#include <dispatch/dispatch.h>
#include <stdlib.h>
#include "_cgo_export.h"

@interface ThalocaMenuBarController : NSObject <NSMenuDelegate> {
    BOOL _snapshotRefreshInFlight;
}
+ (void)install;
- (void)rebuildMenu:(NSMenu *)menu requestRefresh:(BOOL)requestRefresh;
- (void)openThaloca:(id)sender;
- (void)quitThaloca:(id)sender;
- (void)openEngine:(id)sender;
- (void)containerAction:(id)sender;
- (void)projectAction:(id)sender;
- (void)showActionError:(NSString *)message;
@end

static NSStatusItem *thalocaStatusItem;
static ThalocaMenuBarController *thalocaMenuBarController;
static NSWindow *thalocaMainWindow;

static void thalocaHandleActionResult(char *result) {
    if (result == NULL) {
        return;
    }
    NSString *message = [NSString stringWithUTF8String:result];
    free(result);
    if (message.length > 0) {
        [thalocaMenuBarController performSelectorOnMainThread:@selector(showActionError:)
                                                   withObject:message
                                                waitUntilDone:NO];
    }
}

// thalocaStatusEmoji maps a container's normalized status (see
// discovery.NormalizeDockerStatus) to a small colored dot — plain Unicode
// renders in color in a menu item's title with no image/attachment needed.
static NSString *thalocaStatusEmoji(NSString *status) {
    if ([status isEqualToString:@"running"] || [status isEqualToString:@"healthy"]) {
        return @"🟢";
    }
    if ([status isEqualToString:@"unhealthy"]) {
        return @"🟠";
    }
    return @"⚪";
}

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
    button.image = nil;
    button.title = @"T";

    NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Thaloca"];
    menu.delegate = thalocaMenuBarController;
    thalocaStatusItem.menu = menu;
    [menu release];
}

// Build immediately from the cached snapshot so opening the menu never blocks
// AppKit on Docker. At the same time, refresh in the background and rebuild
// the still-open menu when the fresh result arrives. This catches changes
// made while the menu was closed without permanent polling or a one-open lag.
- (void)menuNeedsUpdate:(NSMenu *)menu {
    [self rebuildMenu:menu requestRefresh:YES];
}

- (void)rebuildMenu:(NSMenu *)menu requestRefresh:(BOOL)requestRefresh {
    if (requestRefresh && !_snapshotRefreshInFlight) {
        _snapshotRefreshInFlight = YES;
        NSMenu *menuToRefresh = [menu retain];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            ThalocaMenuBarRefreshSnapshot();
            dispatch_async(dispatch_get_main_queue(), ^{
                _snapshotRefreshInFlight = NO;
                if (thalocaStatusItem.menu == menuToRefresh) {
                    [self rebuildMenu:menuToRefresh requestRefresh:NO];
                }
                [menuToRefresh release];
            });
        });
    }

    [menu removeAllItems];

    NSMenuItem *openItem = [[NSMenuItem alloc]
        initWithTitle:@"Open Thaloca"
               action:@selector(openThaloca:)
        keyEquivalent:@""];
    openItem.target = self;
    [menu addItem:openItem];
    [openItem release];

    char *snapshotJSON = ThalocaMenuBarSnapshot();
    NSString *jsonString = snapshotJSON != NULL ? [NSString stringWithUTF8String:snapshotJSON] : @"{}";
    if (snapshotJSON != NULL) {
        free(snapshotJSON);
    }
    NSData *jsonData = [jsonString dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *snapshot = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil];
    if (![snapshot isKindOfClass:[NSDictionary class]]) {
        snapshot = @{};
    }

    NSString *engineKind = snapshot[@"engine_kind"] ?: @"docker-desktop";
    NSString *engineName = snapshot[@"engine_name"] ?: @"Docker Desktop";
    NSMenuItem *engineItem = [[NSMenuItem alloc]
        initWithTitle:[NSString stringWithFormat:@"Open %@", engineName]
               action:@selector(openEngine:)
        keyEquivalent:@""];
    engineItem.target = self;
    engineItem.representedObject = engineKind;
    [menu addItem:engineItem];
    [engineItem release];

    NSArray *projects = snapshot[@"projects"];
    if ([projects isKindOfClass:[NSArray class]] && projects.count > 0) {
        [menu addItem:[NSMenuItem separatorItem]];

        NSMenuItem *header = [[NSMenuItem alloc] initWithTitle:@"Containers" action:NULL keyEquivalent:@""];
        header.enabled = NO;
        [menu addItem:header];
        [header release];

        for (NSDictionary *project in projects) {
            if (![project isKindOfClass:[NSDictionary class]]) {
                continue;
            }
            NSString *projectKey = project[@"key"] ?: @"";
            NSString *projectName = project[@"name"] ?: @"Standalone";
            NSArray *containers = project[@"containers"];
            if (![containers isKindOfClass:[NSArray class]] || containers.count == 0) {
                continue;
            }

            NSMenuItem *projectItem = [[NSMenuItem alloc] initWithTitle:projectName action:NULL keyEquivalent:@""];
            NSMenu *projectSubmenu = [[NSMenu alloc] initWithTitle:projectName];

            NSMenuItem *startAllItem = [[NSMenuItem alloc] initWithTitle:@"Start all" action:@selector(projectAction:) keyEquivalent:@""];
            startAllItem.target = self;
            startAllItem.representedObject = @{@"key": projectKey, @"action": @"start-all"};
            [projectSubmenu addItem:startAllItem];
            [startAllItem release];

            NSMenuItem *stopAllItem = [[NSMenuItem alloc] initWithTitle:@"Stop all" action:@selector(projectAction:) keyEquivalent:@""];
            stopAllItem.target = self;
            stopAllItem.representedObject = @{@"key": projectKey, @"action": @"stop-all"};
            [projectSubmenu addItem:stopAllItem];
            [stopAllItem release];

            NSMenuItem *restartAllItem = [[NSMenuItem alloc] initWithTitle:@"Restart all" action:@selector(projectAction:) keyEquivalent:@""];
            restartAllItem.target = self;
            restartAllItem.representedObject = @{@"key": projectKey, @"action": @"restart-all"};
            [projectSubmenu addItem:restartAllItem];
            [restartAllItem release];

            [projectSubmenu addItem:[NSMenuItem separatorItem]];

            for (NSDictionary *container in containers) {
                if (![container isKindOfClass:[NSDictionary class]]) {
                    continue;
                }
                NSString *containerID = container[@"id"];
                NSString *name = container[@"name"];
                NSString *status = container[@"status"];
                if (containerID == nil || name == nil) {
                    continue;
                }
                BOOL running = [status isEqualToString:@"running"] || [status isEqualToString:@"healthy"] || [status isEqualToString:@"unhealthy"];

                NSMenuItem *containerItem = [[NSMenuItem alloc]
                    initWithTitle:[NSString stringWithFormat:@"%@ %@", thalocaStatusEmoji(status), name]
                           action:NULL
                    keyEquivalent:@""];
                NSMenu *containerSubmenu = [[NSMenu alloc] initWithTitle:name];

                if (running) {
                    NSMenuItem *stopItem = [[NSMenuItem alloc] initWithTitle:@"Stop" action:@selector(containerAction:) keyEquivalent:@""];
                    stopItem.target = self;
                    stopItem.representedObject = @{@"id": containerID, @"action": @"stop"};
                    [containerSubmenu addItem:stopItem];
                    [stopItem release];

                    NSMenuItem *restartItem = [[NSMenuItem alloc] initWithTitle:@"Restart" action:@selector(containerAction:) keyEquivalent:@""];
                    restartItem.target = self;
                    restartItem.representedObject = @{@"id": containerID, @"action": @"restart"};
                    [containerSubmenu addItem:restartItem];
                    [restartItem release];
                } else {
                    NSMenuItem *startItem = [[NSMenuItem alloc] initWithTitle:@"Start" action:@selector(containerAction:) keyEquivalent:@""];
                    startItem.target = self;
                    startItem.representedObject = @{@"id": containerID, @"action": @"start"};
                    [containerSubmenu addItem:startItem];
                    [startItem release];
                }

                containerItem.submenu = containerSubmenu;
                [containerSubmenu release];
                [projectSubmenu addItem:containerItem];
                [containerItem release];
            }

            projectItem.submenu = projectSubmenu;
            [projectSubmenu release];
            [menu addItem:projectItem];
            [projectItem release];
        }
    }

    [menu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *quitItem = [[NSMenuItem alloc]
        initWithTitle:@"Quit Thaloca"
               action:@selector(quitThaloca:)
        keyEquivalent:@"q"];
    quitItem.target = self;
    [menu addItem:quitItem];
    [quitItem release];
}

// Refresh after close as a useful warm cache too. menuNeedsUpdate also starts
// its own refresh, so external Docker changes made later cannot leave the next
// open stale indefinitely.
- (void)menuDidClose:(NSMenu *)menu {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        ThalocaMenuBarRefreshSnapshot();
    });
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

- (void)openEngine:(id)sender {
    NSMenuItem *item = (NSMenuItem *)sender;
    NSString *kind = [item.representedObject copy];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        @autoreleasepool {
            thalocaHandleActionResult(ThalocaMenuBarOpenEngine((char *)[kind UTF8String]));
            ThalocaMenuBarRefreshSnapshot();
            [kind release];
        }
    });
}

- (void)containerAction:(id)sender {
    NSMenuItem *item = (NSMenuItem *)sender;
    NSDictionary *info = item.representedObject;
    NSString *containerID = [info[@"id"] copy];
    NSString *action = [info[@"action"] copy];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        @autoreleasepool {
            thalocaHandleActionResult(ThalocaMenuBarContainerAction((char *)[containerID UTF8String], (char *)[action UTF8String]));
            ThalocaMenuBarRefreshSnapshot();
            [containerID release];
            [action release];
        }
    });
}

- (void)projectAction:(id)sender {
    NSMenuItem *item = (NSMenuItem *)sender;
    NSDictionary *info = item.representedObject;
    NSString *key = [info[@"key"] copy];
    NSString *action = [info[@"action"] copy];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        @autoreleasepool {
            thalocaHandleActionResult(ThalocaMenuBarProjectAction((char *)[key UTF8String], (char *)[action UTF8String]));
            ThalocaMenuBarRefreshSnapshot();
            [key release];
            [action release];
        }
    });
}

- (void)showActionError:(NSString *)message {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Thaloca action failed";
    alert.informativeText = message;
    alert.alertStyle = NSAlertStyleWarning;
    [alert runModal];
    [alert release];
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
