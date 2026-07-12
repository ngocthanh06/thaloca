package discovery

import "testing"

func TestParsePS(t *testing.T) {
	got, err := parsePS(" 27832  27100 thanh  1.2  0.8  01:12:03 node ./server.js --port 3000\n")
	if err != nil {
		t.Fatalf("parsePS() error = %v", err)
	}
	if got.PID != 27832 || got.ParentPID != 27100 || got.Command != "node ./server.js --port 3000" {
		t.Fatalf("parsePS() = %+v", got)
	}
}

func TestParseCWD(t *testing.T) {
	got := parseCWD("p27832\nfcwd\nn/Volumes/Disk D/project\n")
	if got != "/Volumes/Disk D/project" {
		t.Fatalf("parseCWD() = %q", got)
	}
}
