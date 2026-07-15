//go:build !darwin || !cgo

package main

import "time"

// pasteboardChangeCount has no portable equivalent outside Cocoa, so this
// stub always reports a different value than last time — pollSystemClipboard
// (clipboardHistory.go) then falls back to its previous every-tick behavior
// (checking the enabled setting and reading the system clipboard directly)
// rather than silently never detecting a clipboard change on these builds.
func pasteboardChangeCount() int64 {
	return time.Now().UnixNano()
}
