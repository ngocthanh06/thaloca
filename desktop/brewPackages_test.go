package main

import "testing"

func TestIsSafeBrewName(t *testing.T) {
	cases := map[string]bool{
		"jq":              true,
		"docker-compose":  true,
		"oven-sh/bun/bun": true,
		"python@3.12":     true,
		"":                false,
		"-force":          false,
		"--cask":          false,
	}
	for input, want := range cases {
		if got := isSafeBrewName(input); got != want {
			t.Errorf("isSafeBrewName(%q) = %v, want %v", input, got, want)
		}
	}
}

func TestSplitNonEmptyLines(t *testing.T) {
	got := splitNonEmptyLines("jq\n\ndocker-compose\n  \nlazydocker\n")
	want := []string{"jq", "docker-compose", "lazydocker"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("index %d: got %q, want %q", i, got[i], want[i])
		}
	}
}
