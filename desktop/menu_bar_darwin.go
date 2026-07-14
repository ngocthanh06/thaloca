//go:build darwin && cgo

package main

/*
#cgo LDFLAGS: -framework Cocoa
void ThalocaInstallMenuBar(void);
*/
import "C"

func setupMenuBar() {
	C.ThalocaInstallMenuBar()
}
