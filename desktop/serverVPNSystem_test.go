package main

import "testing"

func TestParseSystemVPNListParsesEnabledServices(t *testing.T) {
	out := `Available network connection services in the current set (*=enabled):
* (Disconnected)   5A735FE5-012C-4C61-8852-91051337EBC9 PPP --> L2TP       "concrete-vpn"                   [PPP:L2TP]
* (Connected)      0BAAE821-4B24-4B0E-B720-9F3BD1E93C51 VPN                "Office IKEv2"                   [VPN:IKEv2]
  (Disconnected)   9C2D31F0-63A2-4E1B-8F5B-1BD9236C6A10 PPP --> L2TP       "disabled one"                   [PPP:L2TP]
`
	services := parseSystemVPNList(out)
	if len(services) != 2 {
		t.Fatalf("expected 2 enabled services, got %d: %+v", len(services), services)
	}
	first := services[0]
	if first.ID != "5A735FE5-012C-4C61-8852-91051337EBC9" || first.Name != "concrete-vpn" || first.Type != "PPP:L2TP" {
		t.Errorf("unexpected first service: %+v", first)
	}
	second := services[1]
	if second.ID != "0BAAE821-4B24-4B0E-B720-9F3BD1E93C51" || second.Name != "Office IKEv2" || second.Type != "VPN:IKEv2" {
		t.Errorf("unexpected second service: %+v", second)
	}
}

func TestParseSystemVPNListIgnoresGarbage(t *testing.T) {
	out := `Available network connection services in the current set (*=enabled):
not a service line
* (Disconnected)   not-a-uuid PPP --> L2TP "x" [PPP:L2TP]
`
	if services := parseSystemVPNList(out); len(services) != 0 {
		t.Fatalf("expected no services from malformed output, got %+v", services)
	}
}

func TestParseSystemVPNListKeepsQuotedNameIntact(t *testing.T) {
	// VPN names are user-chosen and may contain spaces, dashes, unicode.
	out := `* (Connecting)     11111111-2222-3333-4444-555555555555 PPP --> L2TP "Văn phòng — HN" [PPP:L2TP]`
	services := parseSystemVPNList(out)
	if len(services) != 1 || services[0].Name != "Văn phòng — HN" {
		t.Fatalf("expected unicode name to survive parsing, got %+v", services)
	}
}

func TestParseSystemVPNStatusReadsFirstLine(t *testing.T) {
	out := `Disconnected
Extended Status <dictionary> {
  PPP : <dictionary> {
    Status : 0
  }
}`
	if got := parseSystemVPNStatus(out); got != "Disconnected" {
		t.Errorf("expected Disconnected, got %q", got)
	}
	if got := parseSystemVPNStatus("Connected\nExtended Status ..."); got != "Connected" {
		t.Errorf("expected Connected, got %q", got)
	}
	if got := parseSystemVPNStatus(""); got != "" {
		t.Errorf("expected empty status, got %q", got)
	}
}

func TestSystemVPNSaveRejectsEmptyServiceID(t *testing.T) {
	err := systemVPNEngine{}.save("srv1", map[string]string{"serviceID": "   "})
	if err == nil {
		t.Fatal("expected empty serviceID to be rejected")
	}
}
