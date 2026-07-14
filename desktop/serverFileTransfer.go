package main

import (
	"fmt"
	"path"
	"strconv"
)

// scpBaseArgs mirrors sshBaseArgs' flags for the `scp` binary (which takes
// `-P` for port instead of ssh's `-p`, and doesn't take a bare
// `user@host` positional target — that's assembled into the remote path
// argument by the caller instead).
func scpBaseArgs(conn ServerConnection) []string {
	args := []string{
		"-i", conn.KeyPath,
		"-P", strconv.Itoa(conn.Port),
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "ConnectTimeout=8",
	}
	if conn.ProxyJump != "" {
		args = append(args, "-J", conn.ProxyJump)
	}
	return args
}

// UploadServerFile copies a local file to a server over scp and returns a
// job ID immediately; poll ToolActionStatus(jobID) for completion/output,
// the same binding used for RunServerCommand and RunToolAction's jobs.
func (a *App) UploadServerFile(id, localPath, remotePath string) (string, error) {
	conn, ok := findServer(id)
	if !ok {
		return "", fmt.Errorf("unknown server")
	}
	if localPath == "" || remotePath == "" {
		return "", fmt.Errorf("local and remote paths are required")
	}
	target := conn.User + "@" + conn.Host + ":" + remotePath
	args := append(scpBaseArgs(conn), localPath, target)
	jobID := a.startJob("scp-up-"+conn.ID, "scp", args, nil)
	return jobID, nil
}

// DownloadServerFile copies a file from a server to a local directory over
// scp and returns a job ID immediately; poll ToolActionStatus(jobID) for
// completion/output.
func (a *App) DownloadServerFile(id, remotePath, localDir string) (string, error) {
	conn, ok := findServer(id)
	if !ok {
		return "", fmt.Errorf("unknown server")
	}
	if remotePath == "" || localDir == "" {
		return "", fmt.Errorf("remote path and local destination folder are required")
	}
	source := conn.User + "@" + conn.Host + ":" + remotePath
	localPath := path.Join(localDir, path.Base(remotePath))
	args := append(scpBaseArgs(conn), source, localPath)
	jobID := a.startJob("scp-down-"+conn.ID, "scp", args, nil)
	return jobID, nil
}
