# Corresponding Source for Bundled VPN Components

Thaloca distributes pre-built VPN components fetched from checksum-pinned
Homebrew bottles. The exact component versions and license texts are listed in
`THIRD_PARTY_LICENSES.md`; the exact bottle URLs and SHA-256 hashes used for
this build are recorded in `scripts/vpn-binaries.lock`, and the complete,
reproducible fetch/relocation procedure is in
`scripts/fetch-vpn-binaries.sh`.

For components licensed under GPL-2.0, GPL-3.0, or LGPL-2.1, the Thaloca
project offers to provide the complete corresponding source code for the exact
distributed version, including the build and relocation scripts, for no more
than the reasonable physical cost of providing it. This offer is valid to
anyone who receives the binaries for at least three years after the last
distribution of that version. Request it by opening an issue at:

https://github.com/ngocthanh06/thaloca/issues

The upstream source projects are:

- wireguard-tools and wireguard-go: https://www.wireguard.com/repositories/
- GNU Bash: https://ftp.gnu.org/gnu/bash/
- GNU Readline: https://ftp.gnu.org/gnu/readline/
- ncurses: https://invisible-island.net/archives/ncurses/
- GNU gettext: https://ftp.gnu.org/gnu/gettext/
- OpenVPN: https://github.com/OpenVPN/openvpn
- LZO: https://www.oberhumer.com/opensource/lzo/download/
- LZ4: https://github.com/lz4/lz4
- OpenSSL: https://github.com/openssl/openssl
- pkcs11-helper: https://github.com/OpenSC/pkcs11-helper

This notice does not replace the license texts in
`THIRD_PARTY_LICENSES.md`; both files accompany the application.
