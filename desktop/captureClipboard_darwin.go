//go:build darwin && cgo

package main

/*
#cgo LDFLAGS: -framework AppKit -framework Foundation
#include <stdlib.h>
char *ThalocaCopyCapture(const char *path, int asImage);
*/
import "C"

import (
	"fmt"
	"unsafe"
)

func copyCaptureToClipboard(path string, asImage bool) error {
	cpath := C.CString(path)
	defer C.free(unsafe.Pointer(cpath))
	mode := C.int(0)
	if asImage {
		mode = 1
	}
	raw := C.ThalocaCopyCapture(cpath, mode)
	if raw == nil {
		return nil
	}
	defer C.free(unsafe.Pointer(raw))
	return fmt.Errorf("%s", C.GoString(raw))
}
