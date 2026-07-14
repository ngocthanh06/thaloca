# Thaloca Security Scanning Feature - Design Document

## Executive Summary

Thaloca là macOS Developer Control Center tự động phát hiện Docker containers, processes, git repos. Tính năng mới: **Security Scanning** cho phép quét bảo mật bất kỳ dự án nào (trước khi clone, khi đẩy lên git, hoặc local).

---

## Current Architecture Analysis

### Existing Components (Reusable)
| Package | Capability | Reuse For Security Scanning |
|---------|------------|------------------------------|
| `internal/detection` | Project type detection (Go, Node, Python, Docker, Laravel, Django) | Auto-select appropriate scanners per project type |
| `internal/discovery` | Find git repos, Docker containers, listening ports | Discover scan targets; scan all local repos |
| `internal/health` | HTTP/TCP/TLS health checks | Extend for API security headers, TLS config checks |
| `internal/cron` | Scheduled jobs | Schedule periodic security scans |
| `cmd/thaloca/main.go` | CLI commands (discover, inspect, detect, cron, integrations) | Add `scan` and `scan git-hook` commands |

### CLI Entry Points
- `thaloca discover` - Docker/process discovery
- `thaloca inspect <pid>` - Process inspection + project detection  
- `thaloca detect <path>` - Project type detection
- `thaloca cron list` - Cron job listing
- `thaloca integrations` - Integration scanning

---

## Proposed Security Scanning Architecture

### 1. New Package: `internal/security`

```
internal/security/
├── types.go          # Shared types (Finding, Severity, ScannerResult, ScanConfig)
├── scanner.go        # Orchestrator - runs scanners in parallel
├── secrets.go        # Secret detection (gitleaks integration)
├── vulns.go          # Vulnerability scanning (Trivy/grype integration)
├── sast.go           # Static analysis (gosec for Go, semgrep for multi-lang)
├── licenses.go       # License compliance (go-licenses, license-checker)
├── git_hooks.go      # Pre-commit/pre-push hook installation
└── config.go         # Config file support (~/.config/thaloca/security.yaml)
```

### 2. Scanner Types & Tools

| Scanner | Type | Primary Tool | Fallback | Target |
|---------|------|--------------|----------|--------|
| **Secrets** | SAST | `gitleaks` (CLI) | Native Go regex | Git history, working dir, staged files |
| **Vulns** | SCA | `trivy` (CLI) / `grype` | `go-vulndb` | Dependencies (go.mod, package.json, requirements.txt, Cargo.toml, pom.xml) |
| **SAST** | SAST | `gosec` (Go), `semgrep` (multi-lang) | Native Go AST | Source code patterns (SQLi, XSS, hardcoded secrets, etc.) |
| **Licenses** | Compliance | `go-licenses`, `license-checker` | Native parsing | License compatibility, prohibited licenses |

### 3. Zero-Config Philosophy (Thaloca Style)
- **Auto-detect project type** → select relevant scanners
- **Auto-detect tools** → use if installed, skip gracefully if not
- **No config file required** → sensible defaults, override via flags
- **Parallel execution** → all scanners run concurrently
- **Rich output** → table (default), JSON (CI), SARIF (GitHub)

---

## CLI Design

### Command: `thaloca scan`

```bash
# Scan current directory (auto-detect project type)
thaloca scan

# Scan specific path
thaloca scan /path/to/project

# Scan specific types only
thaloca scan --type=secrets,vulns

# JSON output for CI/CD
thaloca scan --json --fail-on=high

# Pre-clone scan (fetch remote repo temporarily)
thaloca scan --url=https://github.com/user/repo.git

# Severity filtering
thaloca scan --severity=medium --fail-on=critical
```

### Command: `thaloca scan git-hook`

```bash
# Install pre-commit hook (scans staged changes)
thaloca scan git-hook --pre-commit --install

# Install pre-push hook (scans all commits being pushed)
thaloca scan git-hook --pre-push --install

# Uninstall
thaloca scan git-hook --pre-commit --uninstall

# Customize hook behavior
thaloca scan git-hook --pre-commit --install --type=secrets --fail-on=high
```

### Flags

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--path` | `-p` | `.` | Path to scan |
| `--url` | `-u` | - | Git URL to clone & scan temporarily |
| `--type` | `-t` | `all` | Comma-separated: secrets,vulns,sast,licenses |
| `--severity` | `-s` | `low` | Minimum severity to report |
| `--fail-on` | `-f` | `high` | Exit code 1 if findings >= this severity |
| `--json` | `-j` | `false` | Output JSON |
| `--sarif` | | `false` | Output SARIF for GitHub |
| `--timeout` | | `5m` | Per-scanner timeout |
| `--config` | `-c` | - | Config file path |

---

## Git Hook Integration

### Pre-commit Hook
- Scans **staged files only** (fast)
- Runs: secrets + SAST (skip vulns/licenses for speed)
- Blocks commit if findings >= `--fail-on` severity
- Skip with `git commit --no-verify`

### Pre-push Hook
- Scans **all commits being pushed** (thorough)
- Runs: all scanner types
- Blocks push if findings >= `--fail-on` severity
- Skip with `git push --no-verify`

### Hook Installation
```bash
# Creates .git/hooks/pre-commit with thaloca scan git-hook logic
thaloca scan git-hook --pre-commit --install

# Creates .git/hooks/pre-push
thaloca scan git-hook --pre-push --install
```

---

## Data Flow

```
User runs: thaloca scan [path]
                │
                ▼
        ┌───────────────┐
        │ detection.Detect(path)  │──► Project type, framework, confidence
        └───────────────┘
                │
                ▼
        ┌───────────────┐
        │ Select Scanners │ (e.g., Go project → gosec + go-vulndb + gitleaks)
        └───────────────┘
                │
                ▼
        ┌───────────────┐
        │ Parallel Run   │
        │ ├─ secrets    │◄── gitleaks (git history + working dir)
        │ ├─ vulns      │◄── trivy/grype (dependency files)
        │ ├─ sast       │◄── gosec/semgrep (source files)
        │ └─ licenses   │◄── go-licenses/license-checker
        └───────────────┘
                │
                ▼
        ┌───────────────┐
        │ Aggregate &    │
        │ Filter by     │
        │ severity      │
        └───────────────┘
                │
                ▼
        ┌───────────────┐
        │ Output        │
        │ Table / JSON  │
        │ Exit code     │
        └───────────────┘
```

---

## Integration with Existing Thaloca Features

### 1. Overview Dashboard
- Add "Security" tab showing scan status per project
- Anomaly strip: "Critical vulns found in project X"

### 2. Runtime View
- Docker containers → scan images for vulns (trivy image scan)
- Show container image vulnerabilities inline

### 3. Git Repositories
- Auto-scan on repo discovery (background)
- Show last scan time, findings count
- "Scan now" button per repo

### 4. Source Control View
- Show secrets/vulns in staged changes before commit
- Inline annotations in diff view

### 5. Notifications
- Native macOS notification for critical findings
- Quiet hours respect

---

## Configuration (Optional)

`~/.config/thaloca/security.yaml`:
```yaml
scanners:
  secrets:
    enabled: true
    config_path: ""  # custom gitleaks.toml
  vulns:
    enabled: true
    db_update: true  # auto-update vulnerability DB
  sast:
    enabled: true
    rulesets: ["gosec", "semgrep:auto"]
  licenses:
    enabled: true
    allow: ["MIT", "Apache-2.0", "BSD-3-Clause"]
    deny: ["GPL-3.0", "AGPL-3.0"]

defaults:
  severity: "low"
  fail_on: "high"
  timeout: "5m"

hooks:
  pre_commit:
    enabled: true
    types: ["secrets", "sast"]
    fail_on: "high"
  pre_push:
    enabled: true
    types: ["all"]
    fail_on: "critical"
```

---

## Implementation Priority

| Phase | Scope | Effort | Value |
|-------|-------|--------|-------|
| **1** | `internal/security/types.go` + `scanner.go` (orchestrator) + `secrets.go` (gitleaks) + CLI `scan` command | Medium | High - immediate secret detection value |
| **2** | `vulns.go` (trivy integration) + `sast.go` (gosec + semgrep) | Medium | High - vulnerability + code quality |
| **3** | `licenses.go` + `git_hooks.go` + `config.go` | Low-Medium | Medium - compliance + developer workflow |
| **4** | Desktop UI integration (Overview, Runtime, Git views) | High | High - full product integration |
| **5** | Scheduled scans via `internal/cron` + notifications | Low | Medium - continuous security |

---

## External Dependencies (CLI Tools)

| Tool | Purpose | Install | Fallback |
|------|---------|---------|----------|
| `gitleaks` | Secret detection | `brew install gitleaks` | Native Go regex patterns |
| `trivy` | Vulnerability scanning | `brew install trivy` | `grype` or `go-vulndb` |
| `gosec` | Go SAST | `go install github.com/securego/gosec/v2/cmd/gosec@latest` | Native Go AST |
| `semgrep` | Multi-lang SAST | `brew install semgrep` | Skip non-Go |
| `go-licenses` | Go license check | `go install github.com/google/go-licenses@latest` | Parse go.mod |
| `license-checker` | Node license check | `npm i -g license-checker` | Parse package.json |

All tools are **optional** - Thaloca works with whatever is installed.

---

## Testing Strategy

1. **Unit tests** - Each scanner's output parsing
2. **Integration tests** - Test repos with known secrets/vulns
3. **Golden files** - Expected JSON output for regression
4. **CLI tests** - Flag combinations, exit codes
5. **Hook tests** - Pre-commit/pre-push behavior

---

## Open Questions for Decision

1. **Pre-clone scanning**: Clone to temp dir, scan, cleanup? Or just local?
2. **SARIF output**: Needed for GitHub Security tab integration?
3. **Default fail-on**: `high` (strict) or `critical` (lenient)?
4. **Auto-scan on repo discovery**: Background scan all discovered git repos?
5. **Desktop UI**: Separate "Security" tab or integrate into existing views?

---

## Summary

Security scanning fits naturally into Thaloca's zero-config discovery philosophy:
- Reuses existing project detection
- Runs locally, no data leaves machine
- Optional external tools, graceful degradation
- CLI-first with desktop integration path
- Git hooks for shift-left security