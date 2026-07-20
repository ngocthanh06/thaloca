//go:build darwin && cgo

package main

/*
#cgo LDFLAGS: -framework Foundation -framework Vision -framework AppKit
#include <stdlib.h>
char *ThalocaRecognizeCaptureText(const char *path);
*/
import "C"

import (
	"fmt"
	"unsafe"
)

func recognizeCaptureText(path string) (string, error) {
	cpath := C.CString(path)
	defer C.free(unsafe.Pointer(cpath))
	raw := C.ThalocaRecognizeCaptureText(cpath)
	if raw == nil {
		return "", fmt.Errorf("OCR returned no result")
	}
	defer C.free(unsafe.Pointer(raw))
	value := C.GoString(raw)
	if len(value) > 6 && value[:6] == "ERROR:" {
		return "", fmt.Errorf("%s", value[6:])
	}
	return value, nil
}
