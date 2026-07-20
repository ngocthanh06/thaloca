//go:build !darwin || !cgo

package main

import "fmt"

func recognizeCaptureText(path string) (string, error) {
	return "", fmt.Errorf("OCR is only supported on macOS")
}
