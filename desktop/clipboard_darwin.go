//go:build darwin && cgo

package main

/*
#cgo LDFLAGS: -framework Cocoa
long long ThalocaPasteboardChangeCount(void);
*/
import "C"

// pasteboardChangeCount wraps NSPasteboard.generalPasteboard.changeCount —
// it increments only when the system clipboard's contents actually change,
// letting pollSystemClipboard (clipboardHistory.go) detect "nothing new"
// without spawning a pbpaste subprocess every tick to find out.
func pasteboardChangeCount() int64 {
	return int64(C.ThalocaPasteboardChangeCount())
}
