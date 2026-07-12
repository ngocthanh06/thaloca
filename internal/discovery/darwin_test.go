package discovery

import (
	"strings"
	"testing"
)

func TestParseLSOF(t *testing.T) {
	input := strings.Join([]string{
		"p1200",
		"cnode",
		"n127.0.0.1:3000",
		"n127.0.0.1:3000",
		"p2200",
		"cpostgres",
		"n*:5432",
		"n[::1]:5433",
	}, "\n")

	got, err := parseLSOF(strings.NewReader(input))
	if err != nil {
		t.Fatalf("parseLSOF() error = %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("parseLSOF() returned %d listeners, want 3", len(got))
	}
	if got[0].PID != 1200 || got[0].Process != "node" || got[0].Port != 3000 {
		t.Fatalf("unexpected first listener: %+v", got[0])
	}
	if got[2].Address != "[::1]" || got[2].Port != 5433 {
		t.Fatalf("unexpected IPv6 listener: %+v", got[2])
	}
}

func TestParseLSOFRejectsInvalidPID(t *testing.T) {
	_, err := parseLSOF(strings.NewReader("pnot-a-pid\n"))
	if err == nil {
		t.Fatal("parseLSOF() error = nil, want invalid PID error")
	}
}
