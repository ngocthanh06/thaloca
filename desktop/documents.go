package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	documentCollection   = "thaloca_documents"
	documentProjectID    = "thaloca"
	documentInstallURL   = "https://longbrain.cc.cd"
	longbrainURL         = "http://localhost:8800"
	qdrantURL            = "http://localhost:6333"
	longbrainContainer   = "longbrain-llamaindex"
	maxDocumentChunk     = 2800
	maxDocumentFileBytes = 50 << 20
)

var supportedDocumentExtensions = map[string]bool{
	".pdf": true, ".docx": true, ".txt": true, ".md": true, ".markdown": true,
}

var ignoredDocumentDirectories = map[string]bool{
	"node_modules": true, "vendor": true, "dist": true, "build": true,
	"target": true, "coverage": true, ".next": true, ".cache": true,
	"pods": true,
}

type DocumentRoot struct {
	Path    string `json:"path"`
	AddedAt string `json:"added_at"`
}

type ManagedDocument struct {
	ID           string   `json:"id"`
	Root         string   `json:"root"`
	Path         string   `json:"path"`
	RelativePath string   `json:"relative_path"`
	Name         string   `json:"name"`
	FileType     string   `json:"file_type"`
	Size         int64    `json:"size"`
	ModifiedAt   float64  `json:"modified_at"`
	ContentHash  string   `json:"content_hash,omitempty"`
	Tags         []string `json:"tags"`
	IndexStatus  string   `json:"index_status"`
	IndexedAt    string   `json:"indexed_at,omitempty"`
	Error        string   `json:"error,omitempty"`
	ChunkCount   int      `json:"chunk_count"`
}

type DocumentLibrary struct {
	Roots             []DocumentRoot    `json:"roots"`
	Documents         []ManagedDocument `json:"documents"`
	PendingDeletes    []string          `json:"pending_deletes,omitempty"`
	EmbeddingProvider string            `json:"embedding_provider,omitempty"`
	EmbeddingModel    string            `json:"embedding_model,omitempty"`
}

type LongbrainDocumentStatus struct {
	Installed         bool   `json:"installed"`
	Healthy           bool   `json:"healthy"`
	QdrantHealthy     bool   `json:"qdrant_healthy"`
	LLMAvailable      bool   `json:"llm_available"`
	EmbeddingProvider string `json:"embedding_provider"`
	EmbeddingModel    string `json:"embedding_model"`
	EmbeddingLocal    bool   `json:"embedding_local"`
	LLMProvider       string `json:"llm_provider"`
	LLMModel          string `json:"llm_model"`
	LLMLocal          bool   `json:"llm_local"`
	URL               string `json:"url"`
	InstallURL        string `json:"install_url"`
	Message           string `json:"message"`
}

type DocumentSnapshot struct {
	Roots         []DocumentRoot          `json:"roots"`
	Documents     []ManagedDocument       `json:"documents"`
	Longbrain     LongbrainDocumentStatus `json:"longbrain"`
	Scanning      bool                    `json:"scanning"`
	ScanCancelled bool                    `json:"scan_cancelled"`
	LastScanAt    string                  `json:"last_scan_at,omitempty"`
	ScanProgress  DocumentScanProgress    `json:"scan_progress"`
}

type DocumentScanProgress struct {
	Phase       string `json:"phase"`
	CurrentFile string `json:"current_file,omitempty"`
	Discovered  int    `json:"discovered"`
	Pending     int    `json:"pending"`
	Indexed     int    `json:"indexed"`
	Failed      int    `json:"failed"`
}

type DocumentChunk struct {
	Text           string `json:"text"`
	ChunkIndex     int    `json:"chunk_index"`
	Page           *int   `json:"page,omitempty"`
	LineStart      *int   `json:"line_start,omitempty"`
	LineEnd        *int   `json:"line_end,omitempty"`
	ParagraphStart *int   `json:"paragraph_start,omitempty"`
	ParagraphEnd   *int   `json:"paragraph_end,omitempty"`
	Heading        string `json:"heading,omitempty"`
}

type DocumentSearchHit struct {
	DocumentID     string  `json:"document_id"`
	Path           string  `json:"path"`
	FileName       string  `json:"file_name"`
	FileType       string  `json:"file_type"`
	ChunkIndex     int     `json:"chunk_index"`
	Page           *int    `json:"page"`
	LineStart      *int    `json:"line_start"`
	LineEnd        *int    `json:"line_end"`
	ParagraphStart *int    `json:"paragraph_start"`
	ParagraphEnd   *int    `json:"paragraph_end"`
	Heading        string  `json:"heading"`
	Text           string  `json:"text"`
	Score          float64 `json:"score"`
}

type DocumentAnswer struct {
	Answer    string              `json:"answer"`
	Citations []DocumentSearchHit `json:"citations"`
}

type pendingDocumentIndex struct {
	doc    ManagedDocument
	chunks []DocumentChunk
	hash   string
}

var documentLibraryMu sync.Mutex

func emptyDocumentLibrary() DocumentLibrary {
	return DocumentLibrary{Roots: []DocumentRoot{}, Documents: []ManagedDocument{}, PendingDeletes: []string{}}
}

func documentLibraryPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".thaloca", "documents.json"), nil
}

func loadDocumentLibrary() DocumentLibrary {
	path, err := documentLibraryPath()
	if err != nil {
		return emptyDocumentLibrary()
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return emptyDocumentLibrary()
	}
	var library DocumentLibrary
	if json.Unmarshal(data, &library) != nil {
		return emptyDocumentLibrary()
	}
	if library.Roots == nil {
		library.Roots = []DocumentRoot{}
	}
	if library.Documents == nil {
		library.Documents = []ManagedDocument{}
	}
	if library.PendingDeletes == nil {
		library.PendingDeletes = []string{}
	}
	return library
}

func saveDocumentLibrary(library DocumentLibrary) error {
	path, err := documentLibraryPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(library, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".documents-*.json")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func documentHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func normalizedProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

func localEmbeddingProvider(provider string) bool {
	switch normalizedProvider(provider) {
	case "fastembed", "sentence-transformers", "sentence_transformers":
		return true
	default:
		return false
	}
}

func localLLMProvider(provider string) bool {
	switch normalizedProvider(provider) {
	case "ollama", "llamacpp", "llama.cpp", "mlx", "lmstudio", "lm-studio":
		return true
	default:
		return false
	}
}

func detectLongbrain(ctx context.Context) LongbrainDocumentStatus {
	status := LongbrainDocumentStatus{URL: longbrainURL, InstallURL: documentInstallURL, Message: "LongBrain is not installed or not running"}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, longbrainURL+"/health", nil)
	resp, err := documentHTTPClient(2 * time.Second).Do(req)
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			var health struct {
				EmbeddingProvider string `json:"embed_provider"`
				EmbeddingModel    string `json:"embed_model"`
				LLMProvider       string `json:"llm_provider"`
				LLMModel          string `json:"llm_model"`
			}
			_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&health)
			status.Installed, status.Healthy, status.Message = true, true, "LongBrain connected"
			status.EmbeddingProvider, status.EmbeddingModel = health.EmbeddingProvider, health.EmbeddingModel
			status.LLMProvider, status.LLMModel = health.LLMProvider, health.LLMModel
			status.EmbeddingLocal = localEmbeddingProvider(health.EmbeddingProvider)
			status.LLMAvailable, status.LLMLocal = health.LLMModel != "", localLLMProvider(health.LLMProvider)
		}
	}
	qreq, _ := http.NewRequestWithContext(ctx, http.MethodGet, qdrantURL+"/collections", nil)
	if qresp, qerr := documentHTTPClient(2 * time.Second).Do(qreq); qerr == nil {
		status.QdrantHealthy = qresp.StatusCode >= 200 && qresp.StatusCode < 300
		qresp.Body.Close()
	}
	if status.Healthy && !status.QdrantHealthy {
		status.Message = "LongBrain is running, but Qdrant is unavailable"
	}
	return status
}

func longbrainDocumentsAvailable(status LongbrainDocumentStatus) bool {
	return status.Healthy && status.QdrantHealthy && status.EmbeddingLocal
}

func requireLongbrainDocuments() (LongbrainDocumentStatus, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer cancel()
	status := detectLongbrain(ctx)
	if !longbrainDocumentsAvailable(status) {
		if status.Healthy && status.QdrantHealthy && !status.EmbeddingLocal {
			return status, fmt.Errorf("document indexing is blocked because embedding provider %q is not on the local-provider allowlist", status.EmbeddingProvider)
		}
		return status, fmt.Errorf("LongBrain is required. Install or start LongBrain and Qdrant first: %s", documentInstallURL)
	}
	return status, nil
}

func documentEmbeddingConfigurationChanged(library DocumentLibrary, status LongbrainDocumentStatus) bool {
	return len(library.Documents) > 0 && (library.EmbeddingProvider != status.EmbeddingProvider || library.EmbeddingModel != status.EmbeddingModel)
}

func (a *App) DocumentLibrary() DocumentSnapshot {
	documentLibraryMu.Lock()
	library := loadDocumentLibrary()
	documentLibraryMu.Unlock()
	sortDocuments(library.Documents)
	ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer cancel()
	return a.documentSnapshot(library, detectLongbrain(ctx))
}

func (a *App) documentSnapshot(library DocumentLibrary, status LongbrainDocumentStatus) DocumentSnapshot {
	a.documentScanMu.Lock()
	scanning, cancelled, last := a.documentScanning, a.documentScanCancelled, a.documentLastScanAt
	progress := a.documentScanProgress
	a.documentScanMu.Unlock()
	lastScan := ""
	if !last.IsZero() {
		lastScan = last.UTC().Format(time.RFC3339)
	}
	return DocumentSnapshot{Roots: library.Roots, Documents: library.Documents, Longbrain: status, Scanning: scanning, ScanCancelled: cancelled, LastScanAt: lastScan, ScanProgress: progress}
}

func (a *App) PickDocumentFolder() (string, error) {
	return wailsruntime.OpenDirectoryDialog(a.ctx, wailsruntime.OpenDialogOptions{Title: "Choose a document folder"})
}

func (a *App) AddDocumentFolder(path string) (DocumentSnapshot, error) {
	if strings.TrimSpace(path) == "" {
		return DocumentSnapshot{}, fmt.Errorf("document folder is required")
	}
	abs, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		return DocumentSnapshot{}, err
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return DocumentSnapshot{}, fmt.Errorf("document folder does not exist")
	}
	if _, err := requireLongbrainDocuments(); err != nil {
		return DocumentSnapshot{}, err
	}
	if err := a.stopDocumentScanAndWait(); err != nil {
		return DocumentSnapshot{}, err
	}
	documentLibraryMu.Lock()
	library := loadDocumentLibrary()
	for _, root := range library.Roots {
		if root.Path == abs {
			documentLibraryMu.Unlock()
			a.startDocumentScanAsync()
			return a.DocumentLibrary(), nil
		}
	}
	library.Roots = append(library.Roots, DocumentRoot{Path: abs, AddedAt: time.Now().UTC().Format(time.RFC3339)})
	err = saveDocumentLibrary(library)
	documentLibraryMu.Unlock()
	if err != nil {
		return DocumentSnapshot{}, err
	}
	a.startDocumentScanAsync()
	return a.DocumentLibrary(), nil
}

func (a *App) RemoveDocumentFolder(path string) (DocumentSnapshot, error) {
	if err := a.stopDocumentScanAndWait(); err != nil {
		return DocumentSnapshot{}, err
	}
	documentLibraryMu.Lock()
	library := loadDocumentLibrary()
	roots := library.Roots[:0]
	removed := []ManagedDocument{}
	for _, root := range library.Roots {
		if root.Path != path {
			roots = append(roots, root)
		}
	}
	docs := library.Documents[:0]
	for _, doc := range library.Documents {
		if doc.Root == path {
			removed = append(removed, doc)
		} else {
			docs = append(docs, doc)
		}
	}
	library.Roots, library.Documents = roots, docs
	for _, doc := range removed {
		library.PendingDeletes = appendUnique(library.PendingDeletes, doc.ID)
	}
	err := saveDocumentLibrary(library)
	documentLibraryMu.Unlock()
	if err != nil {
		return DocumentSnapshot{}, err
	}
	a.startDocumentScanAsync()
	return a.DocumentLibrary(), nil
}

func (a *App) beginDocumentScan() (context.Context, bool) {
	a.documentScanMu.Lock()
	if a.documentScanning {
		a.documentScanMu.Unlock()
		return nil, false
	}
	parent := a.ctx
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	a.documentScanning, a.documentScanCancelled, a.documentScanCancel = true, false, cancel
	a.documentScanProgress = DocumentScanProgress{Phase: "discovering"}
	a.documentProgressEmit = time.Time{}
	a.documentScanMu.Unlock()
	if a.ctx != nil {
		wailsruntime.EventsEmit(a.ctx, "documents-scan-state", true)
	}
	return ctx, true
}

func (a *App) finishDocumentScan(cancelled bool) {
	a.documentScanMu.Lock()
	if a.documentScanCancel != nil {
		a.documentScanCancel()
	}
	a.documentScanning, a.documentScanCancelled, a.documentScanCancel, a.documentLastScanAt = false, cancelled, nil, time.Now()
	a.documentScanProgress.Phase, a.documentScanProgress.CurrentFile = "complete", ""
	if cancelled {
		a.documentScanProgress.Phase = "cancelled"
	}
	progress := a.documentScanProgress
	a.documentScanMu.Unlock()
	if a.ctx != nil {
		wailsruntime.EventsEmit(a.ctx, "documents-scan-progress", progress)
		wailsruntime.EventsEmit(a.ctx, "documents-scan-state", false)
	}
}

func (a *App) CancelDocumentScan() bool {
	a.documentScanMu.Lock()
	cancel, running := a.documentScanCancel, a.documentScanning
	a.documentScanMu.Unlock()
	if cancel != nil {
		a.updateDocumentScanProgress(true, func(progress *DocumentScanProgress) { progress.Phase = "cancelling" })
		cancel()
	}
	return running
}

func (a *App) updateDocumentScanProgress(force bool, update func(*DocumentScanProgress)) {
	a.documentScanMu.Lock()
	update(&a.documentScanProgress)
	now := time.Now()
	emit := force || a.documentProgressEmit.IsZero() || now.Sub(a.documentProgressEmit) >= 100*time.Millisecond
	progress := a.documentScanProgress
	if emit {
		a.documentProgressEmit = now
	}
	a.documentScanMu.Unlock()
	if emit && a.ctx != nil {
		wailsruntime.EventsEmit(a.ctx, "documents-scan-progress", progress)
	}
}

func (a *App) startDocumentScanAsync() bool {
	ctx, started := a.beginDocumentScan()
	if !started {
		return false
	}
	go func() {
		_, cancelled, _ := a.refreshDocuments(ctx)
		a.finishDocumentScan(cancelled)
	}()
	return true
}

func (a *App) isDocumentScanning() bool {
	a.documentScanMu.Lock()
	defer a.documentScanMu.Unlock()
	return a.documentScanning
}

func (a *App) stopDocumentScanAndWait() error {
	if !a.CancelDocumentScan() {
		return nil
	}
	deadline := time.Now().Add(10 * time.Second)
	for a.isDocumentScanning() {
		if time.Now().After(deadline) {
			return fmt.Errorf("the current document scan is still stopping; try again shortly")
		}
		time.Sleep(25 * time.Millisecond)
	}
	return nil
}

func (a *App) pollDocumentsLoop() {
	_, _ = a.RefreshDocuments()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-ticker.C:
			_, _ = a.RefreshDocuments()
		}
	}
}

func (a *App) RefreshDocuments() (DocumentSnapshot, error) {
	if _, err := requireLongbrainDocuments(); err != nil {
		return a.DocumentLibrary(), err
	}
	ctx, started := a.beginDocumentScan()
	if !started {
		return a.DocumentLibrary(), nil
	}
	snapshot, cancelled, err := a.refreshDocuments(ctx)
	a.finishDocumentScan(cancelled)
	snapshot.Scanning, snapshot.ScanCancelled = false, cancelled
	return snapshot, err
}

func (a *App) refreshDocuments(ctx context.Context) (DocumentSnapshot, bool, error) {
	status := detectLongbrain(ctx)
	documentLibraryMu.Lock()
	library := loadDocumentLibrary()
	documentLibraryMu.Unlock()
	if !longbrainDocumentsAvailable(status) {
		return a.documentSnapshot(library, status), false, fmt.Errorf("document indexing requires a verified local embedding provider")
	}
	if documentEmbeddingConfigurationChanged(library, status) {
		if err := deleteDocumentCollection(ctx); err != nil {
			return a.documentSnapshot(library, status), false, fmt.Errorf("reset document index after embedding model change: %w", err)
		}
		library.PendingDeletes = []string{}
		for index := range library.Documents {
			library.Documents[index].ContentHash = ""
			library.Documents[index].IndexedAt = ""
			library.Documents[index].ChunkCount = 0
			library.Documents[index].IndexStatus = "pending"
			library.Documents[index].Error = "embedding model changed; reindex required"
		}
	}
	library.EmbeddingProvider, library.EmbeddingModel = status.EmbeddingProvider, status.EmbeddingModel
	previous := map[string]ManagedDocument{}
	for _, doc := range library.Documents {
		previous[doc.Path] = doc
	}
	found := map[string]bool{}
	next := []ManagedDocument{}
	work := []pendingDocumentIndex{}
	cancelled := false
	for _, root := range library.Roots {
		if ctx.Err() != nil {
			cancelled = true
			break
		}
		if info, err := os.Stat(root.Path); err != nil || !info.IsDir() {
			for _, old := range library.Documents {
				if old.Root == root.Path && !found[old.Path] {
					found[old.Path] = true
					old.IndexStatus, old.Error = "unavailable", "folder is currently unavailable"
					next = append(next, old)
				}
			}
			continue
		}
		walkErr := filepath.WalkDir(root.Path, func(path string, entry os.DirEntry, walkErr error) error {
			if ctx.Err() != nil {
				return context.Canceled
			}
			if walkErr != nil {
				return nil
			}
			if entry.IsDir() {
				if path != root.Path && shouldSkipDocumentDirectory(entry.Name()) {
					return filepath.SkipDir
				}
				return nil
			}
			ext := strings.ToLower(filepath.Ext(entry.Name()))
			if !supportedDocumentExtensions[ext] || found[path] {
				return nil
			}
			a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) {
				progress.Discovered++
				progress.CurrentFile = path
			})
			info, err := entry.Info()
			if err != nil {
				return nil
			}
			rel, _ := filepath.Rel(root.Path, path)
			doc := ManagedDocument{ID: documentID(path), Root: root.Path, Path: path, RelativePath: rel, Name: entry.Name(), FileType: strings.TrimPrefix(ext, "."), Size: info.Size(), ModifiedAt: float64(info.ModTime().UnixNano()) / 1e9, Tags: []string{}, IndexStatus: "pending"}
			old, hadOld := previous[path]
			if hadOld {
				doc.Tags, doc.ContentHash, doc.IndexStatus, doc.IndexedAt, doc.Error, doc.ChunkCount = old.Tags, old.ContentHash, old.IndexStatus, old.IndexedAt, old.Error, old.ChunkCount
				if old.Size == doc.Size && old.ModifiedAt == doc.ModifiedAt && old.IndexStatus == "indexed" {
					found[path] = true
					next = append(next, doc)
					return nil
				}
			}
			if !status.Healthy || !status.QdrantHealthy {
				doc.IndexStatus, doc.Error = "waiting", "Install or start LongBrain to index this document"
				a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) { progress.Pending++ })
				found[path] = true
				next = append(next, doc)
				return nil
			}
			if info.Size() > maxDocumentFileBytes {
				doc.IndexStatus, doc.Error = "failed", "file exceeds the 50 MB indexing limit"
				a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) { progress.Failed++ })
				found[path] = true
				next = append(next, doc)
				return nil
			}
			chunks, hash, extractErr := extractDocument(path, ext)
			if extractErr != nil {
				doc.IndexStatus, doc.Error = "failed", extractErr.Error()
				a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) { progress.Failed++ })
				found[path] = true
				next = append(next, doc)
				return nil
			}
			work = append(work, pendingDocumentIndex{doc: doc, chunks: chunks, hash: hash})
			a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) { progress.Pending++ })
			found[path] = true
			return nil
		})
		if errors.Is(walkErr, context.Canceled) {
			cancelled = true
			break
		}
	}
	if !cancelled && len(work) > 0 {
		a.updateDocumentScanProgress(true, func(progress *DocumentScanProgress) {
			progress.Phase, progress.CurrentFile = "embedding", ""
		})
		texts := []string{}
		for _, item := range work {
			for _, chunk := range item.chunks {
				texts = append(texts, chunk.Text)
			}
		}
		vectors, embedErr := embedWithLongbrain(ctx, texts)
		offset := 0
		for _, item := range work {
			if ctx.Err() != nil {
				cancelled = true
				break
			}
			count := len(item.chunks)
			doc := item.doc
			a.updateDocumentScanProgress(true, func(progress *DocumentScanProgress) {
				progress.Phase, progress.CurrentFile = "indexing", doc.Path
			})
			if embedErr != nil {
				doc.IndexStatus, doc.Error = "failed", embedErr.Error()
				a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) { progress.Failed++ })
			} else if err := upsertDocument(ctx, doc, item.hash, item.chunks, vectors[offset:offset+count]); err != nil {
				doc.IndexStatus, doc.Error = "failed", err.Error()
				a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) { progress.Failed++ })
			} else {
				doc.IndexStatus, doc.Error, doc.ContentHash, doc.IndexedAt, doc.ChunkCount = "indexed", "", item.hash, time.Now().UTC().Format(time.RFC3339), count
				a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) { progress.Indexed++ })
			}
			next = append(next, doc)
			offset += count
		}
	}
	if cancelled || ctx.Err() != nil {
		cancelled = true
		for path, old := range previous {
			if !containsDocumentPath(next, path) {
				next = append(next, old)
			}
		}
	} else {
		a.updateDocumentScanProgress(true, func(progress *DocumentScanProgress) {
			progress.Phase, progress.CurrentFile = "cleaning", ""
		})
		remaining := library.PendingDeletes[:0]
		for _, id := range library.PendingDeletes {
			if deleteDocumentIndex(ctx, id) != nil {
				remaining = append(remaining, id)
			}
		}
		library.PendingDeletes = remaining
		for path, old := range previous {
			if !found[path] && deleteDocumentIndex(ctx, old.ID) != nil {
				library.PendingDeletes = appendUnique(library.PendingDeletes, old.ID)
			}
		}
	}
	library.Documents = next
	sortDocuments(library.Documents)
	documentLibraryMu.Lock()
	defer documentLibraryMu.Unlock()
	if err := saveDocumentLibrary(library); err != nil {
		return DocumentSnapshot{}, cancelled, err
	}
	return a.documentSnapshot(library, status), cancelled, nil
}

func shouldSkipDocumentDirectory(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	return strings.HasPrefix(name, ".") || ignoredDocumentDirectories[name]
}

func containsDocumentPath(docs []ManagedDocument, path string) bool {
	for _, doc := range docs {
		if doc.Path == path {
			return true
		}
	}
	return false
}
func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}
func sortDocuments(docs []ManagedDocument) {
	sort.Slice(docs, func(i, j int) bool { return strings.ToLower(docs[i].Path) < strings.ToLower(docs[j].Path) })
}
func documentID(path string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(path)))
	return hex.EncodeToString(sum[:16])
}

const embedWorkerScript = `import json,sys
from app import providers
request=json.load(sys.stdin)
model=providers.build_embed_model()
json.dump({"vectors":[model.get_text_embedding(text) for text in request["texts"]]},sys.stdout)`

func embedWithLongbrainBatch(ctx context.Context, texts []string) ([][]float64, error) {
	data, _ := json.Marshal(map[string]any{"texts": texts})
	cmd := exec.CommandContext(ctx, "docker", "exec", "-i", longbrainContainer, "python", "-c", embedWorkerScript)
	cmd.Stdin = bytes.NewReader(data)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, context.Canceled
		}
		return nil, fmt.Errorf("LongBrain embedding failed: %s", strings.TrimSpace(stderr.String()))
	}
	var response struct {
		Vectors [][]float64 `json:"vectors"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
		return nil, fmt.Errorf("invalid LongBrain embedding response: %w", err)
	}
	if len(response.Vectors) != len(texts) {
		return nil, fmt.Errorf("LongBrain returned %d embeddings for %d chunks", len(response.Vectors), len(texts))
	}
	return response.Vectors, nil
}

func embedWithLongbrain(ctx context.Context, texts []string) ([][]float64, error) {
	const batchSize = 64
	vectors := make([][]float64, 0, len(texts))
	for start := 0; start < len(texts); start += batchSize {
		end := start + batchSize
		if end > len(texts) {
			end = len(texts)
		}
		batch, err := embedWithLongbrainBatch(ctx, texts[start:end])
		if err != nil {
			return nil, err
		}
		vectors = append(vectors, batch...)
	}
	return vectors, nil
}

func ensureDocumentCollection(ctx context.Context, dimension int) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, qdrantURL+"/collections/"+documentCollection, nil)
	resp, err := documentHTTPClient(5 * time.Second).Do(req)
	if err == nil && resp.StatusCode == http.StatusOK {
		var collection struct {
			Result struct {
				Config struct {
					Params struct {
						Vectors struct {
							Size int `json:"size"`
						} `json:"vectors"`
					} `json:"params"`
				} `json:"config"`
			} `json:"result"`
		}
		decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&collection)
		resp.Body.Close()
		if decodeErr != nil {
			return fmt.Errorf("read %s configuration: %w", documentCollection, decodeErr)
		}
		if collection.Result.Config.Params.Vectors.Size != dimension {
			return fmt.Errorf("%s uses vector size %d, but LongBrain returned %d; remove the stale collection and scan again", documentCollection, collection.Result.Config.Params.Vectors.Size, dimension)
		}
		return nil
	}
	if resp != nil {
		resp.Body.Close()
	}
	body, _ := json.Marshal(map[string]any{"vectors": map[string]any{"size": dimension, "distance": "Cosine"}})
	req, _ = http.NewRequestWithContext(ctx, http.MethodPut, qdrantURL+"/collections/"+documentCollection, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err = documentHTTPClient(15 * time.Second).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return fmt.Errorf("create %s failed: %s", documentCollection, strings.TrimSpace(string(message)))
	}
	return nil
}

func deleteDocumentCollection(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, qdrantURL+"/collections/"+documentCollection, nil)
	resp, err := documentHTTPClient(15 * time.Second).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return fmt.Errorf("Qdrant collection delete failed: %s", strings.TrimSpace(string(message)))
	}
	return nil
}

func qdrantPointID(documentID, version string, chunk int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%d", documentID, version, chunk)))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[:8], h[8:12], h[12:16], h[16:20], h[20:])
}

func upsertDocument(ctx context.Context, doc ManagedDocument, version string, chunks []DocumentChunk, vectors [][]float64) error {
	if len(vectors) == 0 {
		return fmt.Errorf("document has no embeddings")
	}
	if err := ensureDocumentCollection(ctx, len(vectors[0])); err != nil {
		return err
	}
	for start := 0; start < len(chunks); start += 64 {
		end := start + 64
		if end > len(chunks) {
			end = len(chunks)
		}
		points := []map[string]any{}
		for i := start; i < end; i++ {
			chunk := chunks[i]
			payload := map[string]any{"document_id": doc.ID, "version": version, "path": doc.Path, "file_name": doc.Name, "file_type": doc.FileType, "chunk_index": chunk.ChunkIndex, "text": chunk.Text, "project_id": documentProjectID}
			if chunk.Page != nil {
				payload["page"] = *chunk.Page
			}
			if chunk.LineStart != nil {
				payload["line_start"] = *chunk.LineStart
			}
			if chunk.LineEnd != nil {
				payload["line_end"] = *chunk.LineEnd
			}
			if chunk.ParagraphStart != nil {
				payload["paragraph_start"] = *chunk.ParagraphStart
			}
			if chunk.ParagraphEnd != nil {
				payload["paragraph_end"] = *chunk.ParagraphEnd
			}
			if chunk.Heading != "" {
				payload["heading"] = chunk.Heading
			}
			points = append(points, map[string]any{"id": qdrantPointID(doc.ID, version, chunk.ChunkIndex), "vector": vectors[i], "payload": payload})
		}
		body, _ := json.Marshal(map[string]any{"points": points})
		req, _ := http.NewRequestWithContext(ctx, http.MethodPut, qdrantURL+"/collections/"+documentCollection+"/points?wait=true", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := documentHTTPClient(60 * time.Second).Do(req)
		if err != nil {
			return err
		}
		responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("Qdrant upsert failed: %s", strings.TrimSpace(string(responseBody)))
		}
	}
	filter := map[string]any{"must": []any{map[string]any{"key": "document_id", "match": map[string]any{"value": doc.ID}}}, "must_not": []any{map[string]any{"key": "version", "match": map[string]any{"value": version}}}}
	return deleteQdrantFilter(ctx, filter)
}

func deleteDocumentIndex(ctx context.Context, id string) error {
	return deleteQdrantFilter(ctx, map[string]any{"must": []any{map[string]any{"key": "document_id", "match": map[string]any{"value": id}}}})
}

func deleteQdrantFilter(ctx context.Context, filter map[string]any) error {
	body, _ := json.Marshal(map[string]any{"filter": filter})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, qdrantURL+"/collections/"+documentCollection+"/points/delete?wait=true", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := documentHTTPClient(30 * time.Second).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return fmt.Errorf("Qdrant delete failed: %s", strings.TrimSpace(string(message)))
	}
	return nil
}

func (a *App) SearchDocuments(query string) ([]DocumentSearchHit, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []DocumentSearchHit{}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	status := detectLongbrain(ctx)
	if !longbrainDocumentsAvailable(status) {
		return nil, fmt.Errorf("LongBrain is required. Install or start LongBrain and Qdrant first: %s", documentInstallURL)
	}
	documentLibraryMu.Lock()
	library := loadDocumentLibrary()
	documentLibraryMu.Unlock()
	if documentEmbeddingConfigurationChanged(library, status) {
		return nil, fmt.Errorf("LongBrain embedding model changed; scan documents again before searching")
	}
	vectors, err := embedWithLongbrain(ctx, []string{query})
	if err != nil {
		return nil, err
	}
	if err := ensureDocumentCollection(ctx, len(vectors[0])); err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]any{"vector": vectors[0], "limit": 30, "with_payload": true, "score_threshold": 0.2})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, qdrantURL+"/collections/"+documentCollection+"/points/search", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := documentHTTPClient(30 * time.Second).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("document search failed: %s", strings.TrimSpace(string(raw)))
	}
	var result struct {
		Result []struct {
			Score   float64        `json:"score"`
			Payload map[string]any `json:"payload"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	hits := make([]DocumentSearchHit, 0, len(result.Result))
	for _, item := range result.Result {
		hits = append(hits, searchHitFromPayload(item.Payload, item.Score))
	}
	return hits, nil
}

func searchHitFromPayload(p map[string]any, score float64) DocumentSearchHit {
	hit := DocumentSearchHit{DocumentID: stringValue(p["document_id"]), Path: stringValue(p["path"]), FileName: stringValue(p["file_name"]), FileType: stringValue(p["file_type"]), ChunkIndex: intValue(p["chunk_index"]), Heading: stringValue(p["heading"]), Text: stringValue(p["text"]), Score: score}
	hit.Page = optionalInt(p["page"])
	hit.LineStart = optionalInt(p["line_start"])
	hit.LineEnd = optionalInt(p["line_end"])
	hit.ParagraphStart = optionalInt(p["paragraph_start"])
	hit.ParagraphEnd = optionalInt(p["paragraph_end"])
	return hit
}
func stringValue(v any) string { s, _ := v.(string); return s }
func intValue(v any) int {
	if n, ok := v.(float64); ok {
		return int(n)
	}
	return 0
}
func optionalInt(v any) *int {
	if v == nil {
		return nil
	}
	n := intValue(v)
	return &n
}

func (a *App) AskDocuments(question string) (DocumentAnswer, error) {
	status, err := requireLongbrainDocuments()
	if err != nil {
		return DocumentAnswer{}, err
	}
	if !status.LLMAvailable {
		return DocumentAnswer{}, fmt.Errorf("Ask AI is unavailable because LongBrain has no LLM configured")
	}
	if !status.LLMLocal {
		return DocumentAnswer{}, fmt.Errorf("Ask AI is blocked because LLM provider %q is not on the local-provider allowlist; document passages will not be sent", status.LLMProvider)
	}
	hits, err := a.SearchDocuments(question)
	if err != nil {
		return DocumentAnswer{}, err
	}
	if len(hits) == 0 {
		return DocumentAnswer{Answer: "No relevant indexed documents were found.", Citations: []DocumentSearchHit{}}, nil
	}
	if len(hits) > 6 {
		hits = hits[:6]
	}
	var contextText strings.Builder
	for i, hit := range hits {
		fmt.Fprintf(&contextText, "[%d] %s (%s)\n%s\n\n", i+1, hit.FileName, documentLocator(hit), hit.Text)
	}
	prompt := "Answer the question using only the passages below. Cite supporting passages as [1], [2], etc. If the passages are insufficient, say so.\n\nQuestion: " + question + "\n\nPassages:\n" + contextText.String()
	status, err = requireLongbrainDocuments()
	if err != nil || !status.LLMLocal {
		return DocumentAnswer{}, fmt.Errorf("Ask AI stopped because the configured LLM is no longer on the local-provider allowlist")
	}
	payload, _ := json.Marshal(map[string]any{"session_id": fmt.Sprintf("thaloca-documents-%d", time.Now().UnixNano()), "message": prompt})
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, longbrainURL+"/chat", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	resp, err := documentHTTPClient(180 * time.Second).Do(req)
	if err != nil {
		return DocumentAnswer{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return DocumentAnswer{}, fmt.Errorf("LongBrain AI is unavailable: %s", responseDetail(raw))
	}
	var result struct {
		Response string `json:"response"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return DocumentAnswer{}, err
	}
	return DocumentAnswer{Answer: result.Response, Citations: hits}, nil
}

func documentLocator(hit DocumentSearchHit) string {
	if hit.Page != nil {
		return fmt.Sprintf("page %d", *hit.Page)
	}
	if hit.LineStart != nil {
		return fmt.Sprintf("lines %d-%d", *hit.LineStart, valueOr(hit.LineEnd, *hit.LineStart))
	}
	if hit.ParagraphStart != nil {
		return fmt.Sprintf("paragraphs %d-%d", *hit.ParagraphStart, valueOr(hit.ParagraphEnd, *hit.ParagraphStart))
	}
	return fmt.Sprintf("chunk %d", hit.ChunkIndex+1)
}
func valueOr(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return *value
}
func responseDetail(raw []byte) string {
	var value struct {
		Detail string `json:"detail"`
	}
	if json.Unmarshal(raw, &value) == nil && value.Detail != "" {
		return value.Detail
	}
	return strings.TrimSpace(string(raw))
}

func (a *App) OpenDocument(path string) error {
	if !managedDocumentPath(path) {
		return fmt.Errorf("document is not in the managed library")
	}
	return exec.Command("open", path).Run()
}
func (a *App) RevealDocument(path string) error {
	if !managedDocumentPath(path) {
		return fmt.Errorf("document is not in the managed library")
	}
	return exec.Command("open", "-R", path).Run()
}
func managedDocumentPath(path string) bool {
	documentLibraryMu.Lock()
	defer documentLibraryMu.Unlock()
	for _, doc := range loadDocumentLibrary().Documents {
		if doc.Path == path {
			return true
		}
	}
	return false
}

func extractDocument(path, ext string) ([]DocumentChunk, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	var chunks []DocumentChunk
	switch ext {
	case ".txt", ".md", ".markdown":
		chunks = chunkLines(string(data))
	case ".docx":
		chunks, err = extractDOCX(data)
	case ".pdf":
		var pages []string
		pages, err = extractPDFPages(path)
		if err == nil {
			chunks = chunkPages(pages)
		}
	default:
		err = fmt.Errorf("unsupported document type: %s", ext)
	}
	if err != nil {
		return nil, "", err
	}
	if len(chunks) == 0 {
		return nil, "", fmt.Errorf("document contains no extractable text")
	}
	return chunks, hash, nil
}

func chunkLines(text string) []DocumentChunk {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	chunks := []DocumentChunk{}
	start := 0
	for start < len(lines) {
		end, size := start, 0
		for end < len(lines) && (size == 0 || size+len(lines[end])+1 <= maxDocumentChunk) {
			size += len(lines[end]) + 1
			end++
		}
		value := strings.TrimSpace(strings.Join(lines[start:end], "\n"))
		if value != "" {
			a, b := start+1, end
			chunks = append(chunks, DocumentChunk{Text: value, ChunkIndex: len(chunks), LineStart: &a, LineEnd: &b})
		}
		if end == start {
			end++
		}
		start = end
	}
	return chunks
}
func chunkPages(pages []string) []DocumentChunk {
	chunks := []DocumentChunk{}
	for i, pageText := range pages {
		for _, text := range splitText(pageText, maxDocumentChunk) {
			if strings.TrimSpace(text) != "" {
				page := i + 1
				chunks = append(chunks, DocumentChunk{Text: strings.TrimSpace(text), ChunkIndex: len(chunks), Page: &page})
			}
		}
	}
	return chunks
}

func extractDOCX(data []byte) ([]DocumentChunk, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("invalid DOCX: %w", err)
	}
	var document io.ReadCloser
	for _, file := range reader.File {
		if file.Name == "word/document.xml" {
			document, err = file.Open()
			break
		}
	}
	if err != nil || document == nil {
		return nil, fmt.Errorf("DOCX document.xml is missing")
	}
	defer document.Close()
	decoder := xml.NewDecoder(document)
	paragraphs := []string{}
	var current strings.Builder
	inText := false
	for {
		token, tokenErr := decoder.Token()
		if tokenErr == io.EOF {
			break
		}
		if tokenErr != nil {
			return nil, tokenErr
		}
		switch value := token.(type) {
		case xml.StartElement:
			if value.Name.Local == "t" {
				inText = true
			}
			if value.Name.Local == "tab" {
				current.WriteByte('\t')
			}
		case xml.CharData:
			if inText {
				current.Write([]byte(value))
			}
		case xml.EndElement:
			if value.Name.Local == "t" {
				inText = false
			}
			if value.Name.Local == "p" {
				paragraphs = append(paragraphs, strings.TrimSpace(current.String()))
				current.Reset()
			}
		}
	}
	chunks := []DocumentChunk{}
	start := 0
	for start < len(paragraphs) {
		end, size := start, 0
		for end < len(paragraphs) && (size == 0 || size+len(paragraphs[end])+1 <= maxDocumentChunk) {
			size += len(paragraphs[end]) + 1
			end++
		}
		value := strings.TrimSpace(strings.Join(paragraphs[start:end], "\n"))
		if value != "" {
			a, b := start+1, end
			chunks = append(chunks, DocumentChunk{Text: value, ChunkIndex: len(chunks), ParagraphStart: &a, ParagraphEnd: &b})
		}
		if end == start {
			end++
		}
		start = end
	}
	return chunks, nil
}

func splitText(text string, max int) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	result := []string{}
	for utf8.RuneCountInString(text) > max {
		cut := byteIndexForRunes(text, max)
		if at := strings.LastIndexAny(text[:cut], "\n.!? "); at > cut/2 {
			cut = at + 1
		}
		result = append(result, text[:cut])
		text = strings.TrimSpace(text[cut:])
	}
	if text != "" {
		result = append(result, text)
	}
	return result
}
func byteIndexForRunes(text string, count int) int {
	if count <= 0 {
		return 0
	}
	seen := 0
	for index := range text {
		if seen == count {
			return index
		}
		seen++
	}
	return len(text)
}
