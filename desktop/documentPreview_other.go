//go:build !darwin

package main

import "fmt"

func (a *App) PreviewDocument(path string) error {
	if !managedDocumentPath(path) {
		return fmt.Errorf("document is not in the managed library")
	}
	return fmt.Errorf("document preview requires macOS Quick Look")
}
