package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()
	err := wails.Run(&options.App{
		Title:            "Thaloca",
		Width:            1400,
		Height:           900,
		MinWidth:         1000,
		MinHeight:        700,
		BackgroundColour: &options.RGBA{R: 10, G: 14, B: 23, A: 1},
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.Startup,
		OnShutdown:       app.Shutdown,
		Bind:             []interface{}{app},
		// Without an explicit Mac options block, Wails leaves the native
		// green zoom button disabled (it only enables it when Mac.DisableZoom
		// is reachable, i.e. Mac is non-nil) — this restores it. TitleBar
		// and Appearance give a modern, unified look: the traffic lights
		// float inset over the app's own dark background instead of a
		// separate white title bar (see .brand's --wails-draggable in
		// style.css for the window-drag region this needs).
		Mac: &mac.Options{
			TitleBar:   mac.TitleBarHiddenInset(),
			Appearance: mac.NSAppearanceNameDarkAqua,
		},
		// Closing the window hides it instead of quitting, so Thaloca keeps
		// scanning in the background — click the Dock icon to bring the
		// window back. Quit fully via Cmd+Q or the Dock icon's Quit.
		//
		// A real menu bar icon was also tried (energye/systray) but caused
		// a real SIGTRAP crash: it and Wails' own Cocoa run loop both need
		// the main thread on macOS, and no reliable way to reconcile that
		// for this Wails version was found. Not pursued further.
		HideWindowOnClose: true,
	})
	if err != nil {
		log.Fatal(err)
	}
}
