//go:build darwin && cgo

package main

/*
#cgo LDFLAGS: -framework SystemConfiguration -framework CoreFoundation
#include <stdlib.h>

char *ThalocaStartSystemVPN(const char *serviceID);
*/
import "C"

import (
	"fmt"
	"strings"
	"unsafe"
)

// startSystemVPN starts an existing macOS network-connection service using
// its saved default configuration. In particular, it passes NULL userOptions
// to SCNetworkConnectionStart: Thaloca never reads, receives, or stores the
// service's password/shared secret.
func startSystemVPN(serviceID string) error {
	serviceID = strings.TrimSpace(serviceID)
	if serviceID == "" {
		return fmt.Errorf("missing VPN service ID")
	}

	cServiceID := C.CString(serviceID)
	defer C.free(unsafe.Pointer(cServiceID))

	cErr := C.ThalocaStartSystemVPN(cServiceID)
	if cErr == nil {
		return nil
	}
	defer C.free(unsafe.Pointer(cErr))
	return fmt.Errorf("%s", C.GoString(cErr))
}
