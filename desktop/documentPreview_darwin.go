//go:build darwin

package main

import (
	"fmt"
	"io"
	"os/exec"
)

// PreviewDocument opens macOS Quick Look. Office is not required: PDF,
// DOCX and PPTX previews are rendered by the system's installed Quick Look
// generators. The command is intentionally detached from the IPC request so
// closing the preview window never blocks the Thaloca UI.
func (a *App) PreviewDocument(path string) error {
	if !managedDocumentPath(path) {
		return fmt.Errorf("document is not in the managed library")
	}
	cmd := exec.Command("qlmanage", "-p", path)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("Quick Look could not preview this document: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
