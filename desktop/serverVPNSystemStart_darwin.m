#import <CoreFoundation/CoreFoundation.h>
#import <SystemConfiguration/SystemConfiguration.h>

#include <stdlib.h>
#include <string.h>

static char *ThalocaCopyError(const char *message) {
    return strdup(message != NULL ? message : "unknown SystemConfiguration error");
}

char *ThalocaStartSystemVPN(const char *serviceID) {
    if (serviceID == NULL || serviceID[0] == '\0') {
        return ThalocaCopyError("missing VPN service ID");
    }

    CFStringRef serviceIDString = CFStringCreateWithCString(
        kCFAllocatorDefault,
        serviceID,
        kCFStringEncodingUTF8
    );
    if (serviceIDString == NULL) {
        return ThalocaCopyError("invalid VPN service ID");
    }

    SCNetworkConnectionRef connection = SCNetworkConnectionCreateWithServiceID(
        kCFAllocatorDefault,
        serviceIDString,
        NULL,
        NULL
    );
    CFRelease(serviceIDString);
    if (connection == NULL) {
        const char *message = SCErrorString(SCError());
        return ThalocaCopyError(message);
    }

    // NULL is intentional: Apple's public API documents this as using the
    // service's saved defaults. Passing even an empty dictionary can replace
    // the user-specific PPP/IPSec values needed by legacy L2TP profiles.
    Boolean started = SCNetworkConnectionStart(connection, NULL, TRUE);
    int status = started ? 0 : SCError();
    CFRelease(connection);

    if (!started) {
        return ThalocaCopyError(SCErrorString(status));
    }
    return NULL;
}
