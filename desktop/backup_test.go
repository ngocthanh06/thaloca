package main

import (
	"encoding/json"
	"testing"
)

// ImportConfig can't be exercised end-to-end in a unit test (it drives a
// native file-open dialog), but the safety filter it applies to imported
// server entries is a plain function of ConfigBackup.Servers — this
// exercises that filtering logic the same way ImportConfig does.
func TestImportConfigDropsUnsafeServerEntries(t *testing.T) {
	backup := ConfigBackup{
		Servers: []ServerConnection{
			{ID: "safe-1", Name: "ok", Host: "example.com", User: "ubuntu", KeyPath: "/tmp/key.pem"},
			{ID: "unsafe-host", Name: "bad host", Host: "-oProxyCommand=evil", User: "ubuntu", KeyPath: "/tmp/key.pem"},
			{ID: "unsafe-user", Name: "bad user", Host: "example.com", User: "-oProxyCommand=evil", KeyPath: "/tmp/key.pem"},
		},
	}

	var safeServers []ServerConnection
	for _, s := range backup.Servers {
		if isSafeSSHArg(s.Host) && isSafeSSHArg(s.User) {
			safeServers = append(safeServers, s)
		}
	}

	if len(safeServers) != 1 || safeServers[0].ID != "safe-1" {
		t.Fatalf("expected only the safe entry to survive filtering, got %+v", safeServers)
	}
}

func TestNotificationSettingsZeroValueDetection(t *testing.T) {
	var zero NotificationSettings
	if zero != (NotificationSettings{}) {
		t.Fatal("a freshly zero-valued NotificationSettings must compare equal to the empty struct literal")
	}
	nonZero := NotificationSettings{Enabled: true}
	if nonZero == (NotificationSettings{}) {
		t.Fatal("a NotificationSettings with any field set must not compare equal to the empty struct literal")
	}
}

func TestSortedKeysAndSliceToSetRoundTrip(t *testing.T) {
	original := map[string]bool{"a": true, "b": true, "c": true}
	keys := sortedKeys(original)
	restored := sliceToSet(keys)
	if len(restored) != len(original) {
		t.Fatalf("round trip lost entries: got %v from %v", restored, original)
	}
	for k := range original {
		if !restored[k] {
			t.Errorf("expected %q to survive the sortedKeys/sliceToSet round trip", k)
		}
	}
}

func TestConfigBackupDistinguishesMissingAndEmptyDocumentLists(t *testing.T) {
	var current ConfigBackup
	if err := json.Unmarshal([]byte(`{"document_roots":[],"document_exclusions":[]}`), &current); err != nil {
		t.Fatal(err)
	}
	if !current.documentRootsPresent || !current.documentExclusionsPresent {
		t.Fatal("explicit empty lists must be restored, not treated as legacy missing fields")
	}
	var legacy ConfigBackup
	if err := json.Unmarshal([]byte(`{"exported_at":"old"}`), &legacy); err != nil {
		t.Fatal(err)
	}
	if legacy.documentRootsPresent || legacy.documentExclusionsPresent {
		t.Fatal("legacy backups without document fields must preserve current document settings")
	}
}

func TestConfigBackupAlwaysExportsDocumentLists(t *testing.T) {
	data, err := json.Marshal(ConfigBackup{DocumentRoots: []DocumentRoot{}, DocumentExclusions: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	if _, ok := fields["document_roots"]; !ok {
		t.Fatal("document_roots must be present even when empty")
	}
	if _, ok := fields["document_exclusions"]; !ok {
		t.Fatal("document_exclusions must be present even when empty")
	}
}
