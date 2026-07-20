//go:build darwin && cgo

package main

/*
#cgo LDFLAGS: -framework Foundation -framework PDFKit
#include <stdlib.h>
char *ThalocaExtractPDFPages(const char *path, int maxPages);
*/
import "C"
import (
	"encoding/json"
	"fmt"
	"unsafe"
)

func extractPDFPages(path string, maxPages int) ([]string, error) {
	cpath := C.CString(path)
	defer C.free(unsafe.Pointer(cpath))
	raw := C.ThalocaExtractPDFPages(cpath, C.int(maxPages))
	if raw == nil {
		return nil, fmt.Errorf("PDFKit could not read the document")
	}
	defer C.free(unsafe.Pointer(raw))
	var payload struct {
		Pages []string `json:"pages"`
		Error string   `json:"error"`
	}
	if err := json.Unmarshal([]byte(C.GoString(raw)), &payload); err != nil {
		return nil, err
	}
	if payload.Error != "" {
		return nil, fmt.Errorf("%s", payload.Error)
	}
	return payload.Pages, nil
}
