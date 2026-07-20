//go:build !darwin || !cgo

package main

import "fmt"

func copyCaptureToClipboard(path string, asImage bool) error {
	return fmt.Errorf("copying capture media is only supported on macOS")
}
