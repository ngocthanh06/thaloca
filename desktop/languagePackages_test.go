package main

import (
	"strings"
	"testing"
)

func TestIsSafePackageName(t *testing.T) {
	cases := map[string]bool{
		"chalk":           true,
		"@babel/core":     true,
		"docker-compose":  true,
		"guzzlehttp/psr7": true,
		"":                false,
		"-force":          false,
		"@":               false,
	}
	for input, want := range cases {
		if got := isSafePackageName(input); got != want {
			t.Errorf("isSafePackageName(%q) = %v, want %v", input, got, want)
		}
	}
}

func TestLanguagePackageArgsUnknownRegistry(t *testing.T) {
	if _, _, err := languagePackageArgs("gem", "rails", "install"); err == nil {
		t.Error("expected an error for an unknown registry")
	}
}

func TestLanguagePackageArgsRejectsUnsafeName(t *testing.T) {
	if _, _, err := languagePackageArgs("npm", "-g", "install"); err == nil {
		t.Error("expected an error for an unsafe package name")
	}
}

func TestCargoInstallNameLine(t *testing.T) {
	out := "ripgrep v14.1.0:\n    rg\ncargo-edit v0.12.2:\n    cargo-add\n    cargo-rm\n"
	var got []string
	for _, line := range strings.Split(out, "\n") {
		if m := cargoInstallNameLine.FindStringSubmatch(line); m != nil {
			got = append(got, m[1])
		}
	}
	want := []string{"ripgrep", "cargo-edit"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("index %d: got %q, want %q", i, got[i], want[i])
		}
	}
}
