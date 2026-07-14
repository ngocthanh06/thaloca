package health

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ProbePaths are well-known health endpoints tried, in order, when the
// primary guessed endpoint does not answer 2xx. "/" is last so a plain web
// app that answers its root is still reported as up.
var ProbePaths = []string{"/health", "/healthz", "/ready", "/live", "/actuator/health", "/ping", "/"}

type CheckResult struct {
	Name       string
	Type       string
	Target     string
	State      string // healthy, degraded, down, error
	Message    string
	Latency    int64 // nanoseconds
	StatusCode int
	CheckedAt  string
}

type Checker struct {
	client *http.Client
}

func New() *Checker {
	return &Checker{
		client: &http.Client{
			Timeout: 5 * time.Second,
			Transport: &http.Transport{
				DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext,
			},
		},
	}
}

func (c *Checker) Check(ctx context.Context, target string) CheckResult {
	start := time.Now()
	result := CheckResult{
		Name:      extractName(target),
		Type:      detectType(target),
		Target:    target,
		CheckedAt: time.Now().Format(time.RFC3339),
	}

	switch result.Type {
	case "http":
		result = c.checkHTTP(ctx, target, result, start)
	case "tcp":
		result = c.checkTCP(ctx, target, result, start)
	case "tls":
		result = c.checkTLS(ctx, target, result, start)
	default:
		result.State = "error"
		result.Message = "unknown check type"
	}

	return result
}

func (c *Checker) checkHTTP(ctx context.Context, target string, result CheckResult, start time.Time) CheckResult {
	status, err := c.httpGetStatus(ctx, target)
	result.Latency = time.Since(start).Nanoseconds()

	if err != nil {
		// Databases, queues, and other non-HTTP services fail the HTTP probe
		// while being perfectly up: an open TCP port still means alive.
		if hostPort := hostPortFromURL(target); hostPort != "" {
			dialer := &net.Dialer{Timeout: 2 * time.Second}
			if conn, tcpErr := dialer.DialContext(ctx, "tcp", hostPort); tcpErr == nil {
				conn.Close()
				result.State = "reachable"
				result.Message = "port open (not an HTTP service)"
				result.Latency = time.Since(start).Nanoseconds()
				return result
			}
		}
		result.State = "down"
		result.Message = err.Error()
		return result
	}

	result.StatusCode = status
	if status >= 200 && status < 300 {
		result.State = "healthy"
		result.Message = "OK"
		return result
	}

	// Guessed local endpoints (e.g. qdrant answers /healthz, not /health):
	// try the other well-known paths before settling on a worse state.
	if alt, altStatus, ok := c.probeLocalHealthPaths(ctx, target); ok {
		result.State = "healthy"
		result.StatusCode = altStatus
		result.Target = alt
		result.Message = "OK via " + alt
		result.Latency = time.Since(start).Nanoseconds()
		return result
	}

	if status >= 500 {
		result.State = "down"
		result.Message = http.StatusText(status)
	} else {
		result.State = "reachable"
		result.Message = http.StatusText(status)
	}
	return result
}

func (c *Checker) httpGetStatus(ctx context.Context, target string) (int, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
	if err != nil {
		return 0, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

func hostPortFromURL(target string) string {
	u, err := url.Parse(target)
	if err != nil || u.Hostname() == "" {
		return ""
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return net.JoinHostPort(u.Hostname(), port)
}

// probeLocalHealthPaths tries the other well-known health paths on the same
// local host:port. It only runs for guessed localhost URLs so explicit
// user-provided targets keep their exact semantics.
func (c *Checker) probeLocalHealthPaths(ctx context.Context, target string) (string, int, bool) {
	u, err := url.Parse(target)
	if err != nil {
		return "", 0, false
	}
	host := u.Hostname()
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		return "", 0, false
	}
	known := false
	for _, path := range ProbePaths {
		if u.Path == path {
			known = true
			break
		}
	}
	if !known {
		return "", 0, false
	}
	for _, path := range ProbePaths {
		if path == u.Path {
			continue
		}
		alt := *u
		alt.Path = path
		status, err := c.httpGetStatus(ctx, alt.String())
		if err == nil && status >= 200 && status < 300 {
			return alt.String(), status, true
		}
	}
	return "", 0, false
}

func (c *Checker) checkTCP(ctx context.Context, target string, result CheckResult, start time.Time) CheckResult {
	// target format: host:port, optionally prefixed with the "tcp://" scheme
	// detectType recognizes.
	dialer := &net.Dialer{Timeout: 3 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", strings.TrimPrefix(target, "tcp://"))
	latency := time.Since(start).Nanoseconds()
	result.Latency = latency

	if err != nil {
		result.State = "down"
		result.Message = err.Error()
		return result
	}
	conn.Close()
	result.State = "healthy"
	result.Message = "TCP connection successful"
	return result
}

func (c *Checker) checkTLS(ctx context.Context, target string, result CheckResult, start time.Time) CheckResult {
	// target format: host:port, optionally prefixed with the "tls://" scheme
	// detectType recognizes.
	dialer := &net.Dialer{Timeout: 3 * time.Second}
	conn, err := tls.DialWithDialer(dialer, "tcp", strings.TrimPrefix(target, "tls://"), &tls.Config{MinVersion: tls.VersionTLS12})
	latency := time.Since(start).Nanoseconds()
	result.Latency = latency

	if err != nil {
		result.State = "down"
		result.Message = err.Error()
		return result
	}
	defer conn.Close()

	// Check certificate expiry
	if len(conn.ConnectionState().PeerCertificates) > 0 {
		cert := conn.ConnectionState().PeerCertificates[0]
		daysUntilExpiry := int(time.Until(cert.NotAfter).Hours() / 24)
		if daysUntilExpiry < 30 {
			result.State = "degraded"
			result.Message = "TLS OK, cert expires in " + formatDays(daysUntilExpiry)
		} else {
			result.State = "healthy"
			result.Message = "TLS OK, cert expires in " + formatDays(daysUntilExpiry)
		}
	} else {
		result.State = "healthy"
		result.Message = "TLS connection successful"
	}
	return result
}

func detectType(target string) string {
	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") {
		return "http"
	}
	if strings.HasPrefix(target, "tcp://") {
		return "tcp"
	}
	if strings.HasPrefix(target, "tls://") {
		return "tls"
	}
	// Default: if contains : and not http, assume tcp
	if strings.Contains(target, ":") && !strings.HasPrefix(target, "http") {
		return "tcp"
	}
	return "http"
}

func extractName(target string) string {
	// Extract a readable name from target
	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") {
		u := strings.TrimPrefix(target, "https://")
		u = strings.TrimPrefix(u, "http://")
		parts := strings.Split(u, "/")
		return parts[0]
	}
	return target
}

func formatDays(days int) string {
	if days < 0 {
		return "expired"
	}
	if days == 0 {
		return "today"
	}
	if days == 1 {
		return "1 day"
	}
	return strconv.Itoa(days) + " days"
}

func FormatDuration(ns int64) string {
	ms := ns / 1_000_000
	if ms < 1000 {
		return strconv.FormatInt(ms, 10) + "ms"
	}
	s := ms / 1000
	if s < 60 {
		return strconv.FormatInt(s, 10) + "s"
	}
	m := s / 60
	return strconv.FormatInt(m, 10) + "m"
}
