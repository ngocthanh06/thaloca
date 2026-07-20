//go:build !darwin || !cgo

package main

import "fmt"

func extractPDFPages(path string, maxPages int) ([]string, error) {
	return nil, fmt.Errorf("PDF extraction requires macOS PDFKit: %s", path)
}
