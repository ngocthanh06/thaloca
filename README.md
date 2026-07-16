<p align="center"><img src="docs/brand/wordmark.png" alt="Thaloca — Developer Control Center" width="480"></p>

Thaloca is a local-first developer control center for macOS. Open it and it
auto-discovers your local dev environment — Docker containers, processes,
ports, background jobs, Git repos, and remote servers — no manifest or setup
step required.

## Screenshots

| Overview | Runtime | Servers |
| --- | --- | --- |
| ![Overview](docs/screenshots/overview.png) | ![Runtime](docs/screenshots/runtime.png) | ![Servers](docs/screenshots/servers.png) |

## Features

**Runtime discovery**
- Docker containers (grouped by Compose project), local processes, listening
  ports, and background jobs (cron/launchd/PM2/Docker), each with Start/Stop/
  Restart/Logs actions and confirmation on anything destructive.
- HTTP/TCP/TLS health checks against common endpoints (`/health`, `/healthz`,
  `/ready`, `/live`, `/actuator/health`, `/ping`, `/`).
- Overview groups everything into per-project cards (via Docker Compose's own
  project label) and surfaces an anomaly strip for restart loops, degraded
  health, PM2 `errored` jobs, and log-pattern errors (panics/OOM/repeated
  failures) scanned from container logs.

**Source Control** — works like SourceTree: stage/unstage, per-file colored
diffs, commit, conflict resolution ("ours"/"theirs"), commit graph across
branches, Fetch/Pull/Push/Stash. GitHub login via OAuth device flow (or reuses
an active `gh auth` session) powers a full Pull Requests tab: list with
filters/search, Conversation/Commits/Checks/Files-changed detail, inline
review comments on a GitHub-style split diff, merge/squash/rebase.

**Resources** — live CPU/memory/disk/network/GPU usage, a full process list
(sortable, killable), installed-apps scan with CPU/Mem and open/quit actions,
and a 24h sampled history (sparkline charts + a memory-leak heuristic).

**Tools** — detects installed package managers/CLIs and their versions, flags
a project's manifest asking for a tool that isn't installed, and offers
one-click Install/Update through Homebrew (with the exact command shown
before running).

**Documents** — manages folders of existing PDF, DOCX, TXT, and Markdown
files without uploading or copying them. Thaloca scans the folders at startup
and every minute, indexes changed files into its own `thaloca_documents`
collection, and returns semantic matches with page/line/paragraph citations.
Search and Ask AI use a separately installed
[LongBrain (Hermes Agent)](https://longbrain.cc.cd) runtime. Thaloca only
indexes with embedding providers verified as local, and only enables Ask AI
for an explicit allowlist of local LLM providers; external or unknown
providers remain blocked. When LongBrain is unavailable, Thaloca shows the
installation guide and command and leaves dependent actions disabled. Thaloca
never installs or modifies the Hermes Agent repository.

**Servers** — SSH-managed remote hosts: structured health checks (polled
automatically in the background, with a notification if a server drops
offline or its CPU/memory/disk stays under pressure), key permission
warnings, remote Docker container management, a real interactive terminal
(PTY over SSH, xterm.js), remote crontab viewing/enable/disable/remove, a
file browser with upload/download (`scp`), running one command across
several selected servers at once, importing hosts from `~/.ssh/config`, and
ProxyJump/bastion host support. Only a key file *path* is ever stored, never
its contents.

**Cross-cutting** — native notifications (with quiet hours) for problems that
need attention, a port-conflict assistant, clipboard copy history (in-app and
system-wide, auto-expiring after 24h), a global command palette (`Cmd+K`),
config export/import, and a check-for-update notice (see Packaging).

Closing the window hides Thaloca rather than quitting it — background
scanning keeps running; Cmd+Q or the Dock icon's Quit exits fully.

## Packaging

```bash
cd desktop
wails build
./build/package-dmg.sh
```

Produces `desktop/build/bin/Thaloca.dmg`, `Thaloca.app.zip`, and
`Thaloca.app.zip.sha256` via macOS system tools (no extra packaging tooling).
Upload both ZIP assets together so users can verify the download manually.
Builds target Apple Silicon (arm64) only. Code-signing is ad-hoc only (no
Apple Developer ID/notarization), so a downloaded copy shows Gatekeeper's
"unidentified developer" warning — right-click → Open once, or
`xattr -cr /Applications/Thaloca.app`. Checking for updates only opens the
latest GitHub release; installation remains manual until releases are signed
with an independent key or Apple Developer ID.

## Development

```bash
cd desktop
wails dev    # live dev
wails build  # production build
```

## VPN security model

Besides WireGuard and OpenVPN, a server can be linked to a **System VPN** —
any VPN already configured in macOS System Settings (L2TP/IPsec, Cisco
IPSec, IKEv2, …). That engine drives the built-in `scutil --nc` as the
normal user: no administrator prompt, no Homebrew, and credentials stay in
macOS's own Keychain. Note the tunnel is system-wide — connecting or
disconnecting it affects the whole Mac, not just the linked server.

Connecting a per-server VPN runs the user-installed WireGuard/OpenVPN
programs with administrator privileges (macOS's native password prompt —
Thaloca never stores the password). Before anything runs as root, each
program is resolved into its exact Homebrew keg (symlinks fully resolved,
wrong locations rejected), hashed, copied into a root-owned staging
directory, and hash-verified there — so a same-user process swapping a
file while the password dialog is open can only make the connect fail.

Accepted residual risk: the dynamic libraries those programs load still
come from the admin-writable Homebrew prefix by absolute path. This is the
same trust running `sudo wg-quick`/`sudo openvpn` against a Homebrew
install gives them; closing it would require bundling relocated binaries
(rejected for license reasons) or a signed privileged helper.

## License

MIT — see [LICENSE](LICENSE).

Thaloca does not bundle any VPN binaries — WireGuard and OpenVPN are
user-installed via Homebrew (the app offers a one-click `brew install` when
they're missing). Notices for the Go modules and npm packages compiled into
the app are in
[desktop/THIRD_PARTY_NOTICES.md](desktop/THIRD_PARTY_NOTICES.md), also
included in every distributed app bundle.
