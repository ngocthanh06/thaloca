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
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/text/unicode/norm"
)

const (
	documentCollection       = "thaloca_documents"
	documentEmbeddingProfile = "document"
	documentChunkerVersion   = "v1-2800"
	documentProjectID        = "thaloca"
	documentInstallURL       = "https://longbrain.cc.cd"
	longbrainURL             = "http://localhost:8800"
	qdrantURL                = "http://localhost:6333"
	longbrainContainer       = "longbrain-llamaindex"
	maxDocumentChunk         = 2800
	maxDocumentFileBytes     = 20 << 20
	maxDocumentPDFPages      = 200
	maxDocumentPPTXSlides    = 150
	// documentLimitUnlimited is passed as maxPages/maxSlides to bypass the
	// page/slide count cap entirely (DocumentsUnlimitedEnabled) — distinct
	// from 0, which still means "unset, use the default above".
	documentLimitUnlimited = -1
	maxDocumentIndexChunks   = 120
	// Office files are ZIP containers; cap the XML selected for extraction
	// independently of compressed file size to reject highly-compressed ZIP
	// bombs before allocating their expanded text.
	maxDocumentExpandedXMLBytes = 64 << 20
)

var supportedDocumentExtensions = map[string]bool{
	".docx": true, ".txt": true, ".md": true, ".markdown": true,
	".pdf": true, ".pptx": true,
}

var ignoredDocumentDirectories = map[string]bool{
	"node_modules": true, "vendor": true, "dist": true, "build": true,
	"target": true, "coverage": true, ".next": true, ".cache": true,
	"pods": true,
}

type DocumentRoot struct {
	Path    string `json:"path"`
	AddedAt string `json:"added_at"`
	Name    string `json:"name,omitempty"`
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
	Roots                []DocumentRoot    `json:"roots"`
	Documents            []ManagedDocument `json:"documents"`
	ExcludedPaths        []string          `json:"excluded_paths,omitempty"`
	PendingDeletes       []string          `json:"pending_deletes,omitempty"`
	EmbeddingProvider    string            `json:"embedding_provider,omitempty"`
	EmbeddingModel       string            `json:"embedding_model,omitempty"`
	EmbeddingDimension   int               `json:"embedding_dimension,omitempty"`
	EmbeddingFingerprint string            `json:"embedding_fingerprint,omitempty"`
}

type LongbrainDocumentStatus struct {
	Installed            bool   `json:"installed"`
	Healthy              bool   `json:"healthy"`
	QdrantHealthy        bool   `json:"qdrant_healthy"`
	LLMAvailable         bool   `json:"llm_available"`
	EmbeddingProvider    string `json:"embedding_provider"`
	EmbeddingModel       string `json:"embedding_model"`
	EmbeddingDimension   int    `json:"embedding_dimension"`
	EmbeddingFingerprint string `json:"embedding_fingerprint"`
	EmbeddingLocal       bool   `json:"embedding_local"`
	LLMProvider          string `json:"llm_provider"`
	LLMModel             string `json:"llm_model"`
	LLMLocal             bool   `json:"llm_local"`
	URL                  string `json:"url"`
	InstallURL           string `json:"install_url"`
	Message              string `json:"message"`
}

type DocumentSnapshot struct {
	Roots         []DocumentRoot          `json:"roots"`
	Documents     []ManagedDocument       `json:"documents"`
	ExcludedPaths []string                `json:"excluded_paths"`
	Longbrain     LongbrainDocumentStatus `json:"longbrain"`
	Scanning      bool                    `json:"scanning"`
	ScanCancelled bool                    `json:"scan_cancelled"`
	LastScanAt    string                  `json:"last_scan_at,omitempty"`
	ScanProgress  DocumentScanProgress    `json:"scan_progress"`
}

type DocumentScanProgress struct {
	Phase             string                         `json:"phase"`
	CurrentFile       string                         `json:"current_file,omitempty"`
	Discovered        int                            `json:"discovered"`
	Pending           int                            `json:"pending"`
	Indexed           int                            `json:"indexed"`
	Failed            int                            `json:"failed"`
	TotalChunks       int                            `json:"total_chunks"`
	CacheHits         int                            `json:"cache_hits"`
	CacheMisses       int                            `json:"cache_misses"`
	EmbeddingRequests int                            `json:"embedding_requests"`
	EmbeddingMS       int64                          `json:"embedding_ms"`
	ElapsedMS         int64                          `json:"elapsed_ms"`
	EmbeddingBatches  []DocumentEmbeddingBatchMetric `json:"embedding_batches,omitempty"`
}

type DocumentEmbeddingBatchMetric struct {
	Texts      int   `json:"texts"`
	DurationMS int64 `json:"duration_ms"`
}

type DocumentChunk struct {
	Text           string `json:"text"`
	ChunkIndex     int    `json:"chunk_index"`
	Page           *int   `json:"page,omitempty"`
	Slide          *int   `json:"slide,omitempty"`
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
	Slide          *int    `json:"slide"`
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

type documentEmbeddingResult struct {
	Vectors     [][]float64
	Fingerprint string
	CacheHits   int
	CacheMisses int
	Batches     []DocumentEmbeddingBatchMetric
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
	if library.ExcludedPaths == nil {
		library.ExcludedPaths = []string{}
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
	case "fastembed", "huggingface", "ollama", "sentence-transformers", "sentence_transformers":
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
				EmbeddingProvider  string `json:"embed_provider"`
				EmbeddingModel     string `json:"embed_model"`
				EmbeddingDimension int    `json:"embed_dim"`
				DocumentProvider   string `json:"doc_embed_provider"`
				DocumentModel      string `json:"doc_embed_model"`
				DocumentDimension  int    `json:"doc_embed_dim"`
				DocumentReady      bool   `json:"doc_embedder_ready"`
				LLMProvider        string `json:"llm_provider"`
				LLMModel           string `json:"llm_model"`
			}
			_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&health)
			status.Installed, status.Healthy, status.Message = true, true, "LongBrain connected"
			status.EmbeddingProvider = health.DocumentProvider
			if status.EmbeddingProvider == "" {
				status.EmbeddingProvider = health.EmbeddingProvider
			}
			status.EmbeddingModel, status.EmbeddingDimension = health.DocumentModel, health.DocumentDimension
			status.EmbeddingFingerprint = embeddingFingerprint(health.DocumentProvider, health.DocumentModel, health.DocumentDimension)
			status.LLMProvider, status.LLMModel = health.LLMProvider, health.LLMModel
			status.EmbeddingLocal = health.DocumentReady && localEmbeddingProvider(status.EmbeddingProvider)
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
	if len(library.Documents) == 0 {
		return false
	}
	if library.EmbeddingFingerprint != "" && status.EmbeddingFingerprint != "" {
		return library.EmbeddingFingerprint != status.EmbeddingFingerprint
	}
	if library.EmbeddingModel != status.EmbeddingModel {
		return true
	}
	libraryDimension := library.EmbeddingDimension
	if libraryDimension == 0 {
		libraryDimension = embeddingFingerprintDimension(library.EmbeddingFingerprint)
	}
	return libraryDimension > 0 && status.EmbeddingDimension > 0 && libraryDimension != status.EmbeddingDimension
}

func prepareDocumentEmbeddingMigration(library *DocumentLibrary, status LongbrainDocumentStatus) error {
	oldDimension := library.EmbeddingDimension
	if oldDimension == 0 {
		oldDimension = embeddingFingerprintDimension(library.EmbeddingFingerprint)
	}
	if oldDimension > 0 && status.EmbeddingDimension > 0 && oldDimension != status.EmbeddingDimension {
		return fmt.Errorf("LongBrain embedding dimension changed from %d to %d; the existing document index was preserved because it cannot safely mix vector dimensions", oldDimension, status.EmbeddingDimension)
	}
	for index := range library.Documents {
		doc := &library.Documents[index]
		if doc.IndexStatus != "indexed" {
			continue
		}
		doc.ContentHash = ""
		doc.IndexedAt = ""
		doc.ChunkCount = 0
		doc.IndexStatus = "pending"
		doc.Error = "embedding model changed; reindex required"
	}
	library.EmbeddingProvider = status.EmbeddingProvider
	library.EmbeddingModel = status.EmbeddingModel
	library.EmbeddingDimension = status.EmbeddingDimension
	library.EmbeddingFingerprint = status.EmbeddingFingerprint
	return nil
}

func embeddingFingerprint(provider, model string, dimension int) string {
	if strings.TrimSpace(provider) == "" || strings.TrimSpace(model) == "" || dimension <= 0 {
		return ""
	}
	return fmt.Sprintf("%s:%s:%d", provider, model, dimension)
}

func embeddingFingerprintDimension(fingerprint string) int {
	separator := strings.LastIndex(fingerprint, ":")
	if separator < 0 || separator == len(fingerprint)-1 {
		return 0
	}
	dimension, _ := strconv.Atoi(fingerprint[separator+1:])
	return dimension
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
	return DocumentSnapshot{Roots: library.Roots, Documents: library.Documents, ExcludedPaths: library.ExcludedPaths, Longbrain: status, Scanning: scanning, ScanCancelled: cancelled, LastScanAt: lastScan, ScanProgress: progress}
}

func (a *App) ExcludeDocument(path string) (DocumentSnapshot, error) {
	path, err := normalizedDocumentRoot(path)
	if err != nil {
		return DocumentSnapshot{}, err
	}
	if err := a.stopDocumentScanAndWait(); err != nil {
		return DocumentSnapshot{}, err
	}
	documentLibraryMu.Lock()
	library := loadDocumentLibrary()
	library.ExcludedPaths = appendUnique(library.ExcludedPaths, path)
	docs := library.Documents[:0]
	for _, doc := range library.Documents {
		if sameDocumentPath(doc.Path, path) {
			library.PendingDeletes = appendUnique(library.PendingDeletes, doc.ID)
		} else {
			docs = append(docs, doc)
		}
	}
	library.Documents = docs
	err = saveDocumentLibrary(library)
	documentLibraryMu.Unlock()
	if err != nil {
		return DocumentSnapshot{}, err
	}
	a.startDocumentScanAsync()
	return a.DocumentLibrary(), nil
}

func (a *App) RestoreExcludedDocument(path string) (DocumentSnapshot, error) {
	path, err := normalizedDocumentRoot(path)
	if err != nil {
		return DocumentSnapshot{}, err
	}
	documentLibraryMu.Lock()
	library := loadDocumentLibrary()
	kept := library.ExcludedPaths[:0]
	for _, excluded := range library.ExcludedPaths {
		if !sameDocumentPath(excluded, path) {
			kept = append(kept, excluded)
		}
	}
	library.ExcludedPaths = kept
	err = saveDocumentLibrary(library)
	documentLibraryMu.Unlock()
	if err != nil {
		return DocumentSnapshot{}, err
	}
	a.startDocumentScanAsync()
	return a.DocumentLibrary(), nil
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

// RenameDocumentFolder changes only the friendly label shown by Thaloca.
// It never renames, moves, re-scans, or re-indexes the directory itself.
func (a *App) RenameDocumentFolder(path, name string) (DocumentSnapshot, error) {
	path, err := normalizedDocumentRoot(path)
	if err != nil {
		return DocumentSnapshot{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return DocumentSnapshot{}, fmt.Errorf("folder name is required")
	}
	if utf8.RuneCountInString(name) > 80 {
		return DocumentSnapshot{}, fmt.Errorf("folder name must be 80 characters or fewer")
	}
	documentLibraryMu.Lock()
	library := loadDocumentLibrary()
	found := false
	for index := range library.Roots {
		if sameDocumentPath(library.Roots[index].Path, path) {
			library.Roots[index].Name = name
			found = true
			break
		}
	}
	if !found {
		documentLibraryMu.Unlock()
		return DocumentSnapshot{}, fmt.Errorf("document folder is not managed")
	}
	err = saveDocumentLibrary(library)
	documentLibraryMu.Unlock()
	if err != nil {
		return DocumentSnapshot{}, err
	}
	return a.DocumentLibrary(), nil
}

func (a *App) RemoveDocumentFolder(path string) (DocumentSnapshot, error) {
	path, err := normalizedDocumentRoot(path)
	if err != nil {
		return DocumentSnapshot{}, err
	}
	if err := a.stopDocumentScanAndWait(); err != nil {
		return DocumentSnapshot{}, err
	}
	documentLibraryMu.Lock()
	library := loadDocumentLibrary()
	roots := library.Roots[:0]
	removed := []ManagedDocument{}
	foundRoot := false
	for _, root := range library.Roots {
		if !sameDocumentPath(root.Path, path) {
			roots = append(roots, root)
		} else {
			foundRoot = true
		}
	}
	docs := library.Documents[:0]
	for _, doc := range library.Documents {
		if sameDocumentPath(doc.Root, path) {
			removed = append(removed, doc)
		} else {
			docs = append(docs, doc)
		}
	}
	if !foundRoot {
		documentLibraryMu.Unlock()
		return a.DocumentLibrary(), nil
	}
	library.Roots, library.Documents = roots, docs
	for _, doc := range removed {
		library.PendingDeletes = appendUnique(library.PendingDeletes, doc.ID)
	}
	err = saveDocumentLibrary(library)
	documentLibraryMu.Unlock()
	if err != nil {
		return DocumentSnapshot{}, err
	}
	a.startDocumentScanAsync()
	return a.DocumentLibrary(), nil
}

func normalizedDocumentRoot(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("document folder is required")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}

func sameDocumentPath(left, right string) bool {
	leftPath, leftErr := normalizedDocumentRoot(left)
	rightPath, rightErr := normalizedDocumentRoot(right)
	return leftErr == nil && rightErr == nil && leftPath == rightPath
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
	a.documentScanStartedAt = time.Now()
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
	a.documentScanProgress.ElapsedMS = time.Since(a.documentScanStartedAt).Milliseconds()
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
		_, cancelled, _ := a.refreshDocuments(ctx, true)
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
	_, _ = a.refreshDocumentsAutomatically()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-ticker.C:
			_, _ = a.refreshDocumentsAutomatically()
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
	snapshot, cancelled, err := a.refreshDocuments(ctx, true)
	a.finishDocumentScan(cancelled)
	snapshot.Scanning, snapshot.ScanCancelled = false, cancelled
	return snapshot, err
}

func (a *App) refreshDocumentsAutomatically() (DocumentSnapshot, error) {
	if _, err := requireLongbrainDocuments(); err != nil {
		return a.DocumentLibrary(), err
	}
	ctx, started := a.beginDocumentScan()
	if !started {
		return a.DocumentLibrary(), nil
	}
	snapshot, cancelled, err := a.refreshDocuments(ctx, false)
	a.finishDocumentScan(cancelled)
	return snapshot, err
}

func (a *App) refreshDocuments(ctx context.Context, retryFailed bool) (DocumentSnapshot, bool, error) {
	status := detectLongbrain(ctx)
	documentLibraryMu.Lock()
	library := loadDocumentLibrary()
	documentLibraryMu.Unlock()
	if !longbrainDocumentsAvailable(status) {
		return a.documentSnapshot(library, status), false, fmt.Errorf("document indexing requires a verified local embedding provider")
	}
	if documentEmbeddingConfigurationChanged(library, status) {
		// Re-embed in place when the collection's vector dimension is compatible.
		// Existing Qdrant points remain searchable until their deterministic IDs
		// are overwritten, so a crash or temporary embedding failure loses no
		// indexed data. Persist the target fingerprint first so the next scan can
		// resume rather than getting trapped on the same mismatch forever.
		if err := prepareDocumentEmbeddingMigration(&library, status); err != nil {
			return a.documentSnapshot(library, status), false, err
		}
		if err := saveDocumentLibrary(library); err != nil {
			return a.documentSnapshot(library, status), false, fmt.Errorf("save embedding migration checkpoint: %w", err)
		}
	}
	if expected := indexedDocumentChunkCount(library); expected > 0 {
		actual, err := documentCollectionPointCount(ctx)
		if err != nil {
			return a.documentSnapshot(library, status), false, fmt.Errorf("verify document index: %w", err)
		}
		if actual != expected {
			for index := range library.Documents {
				doc := &library.Documents[index]
				if doc.IndexStatus != "indexed" || doc.ChunkCount <= 0 {
					continue
				}
				stored, countErr := documentCollectionDocumentPointCount(ctx, doc.ID)
				if countErr != nil {
					return a.documentSnapshot(library, status), false, fmt.Errorf("verify document %s index: %w", doc.Name, countErr)
				}
				if stored == doc.ChunkCount {
					continue
				}
				doc.ContentHash = ""
				doc.IndexedAt = ""
				doc.ChunkCount = 0
				doc.IndexStatus = "pending"
				doc.Error = fmt.Sprintf("document index is incomplete (%d chunks found); reindex required", stored)
			}
		}
	}
	library.EmbeddingProvider, library.EmbeddingModel, library.EmbeddingDimension = status.EmbeddingProvider, status.EmbeddingModel, status.EmbeddingDimension
	if status.EmbeddingFingerprint != "" {
		library.EmbeddingFingerprint = status.EmbeddingFingerprint
	}
	previous := map[string]ManagedDocument{}
	for _, doc := range library.Documents {
		previous[doc.Path] = doc
	}
	found := map[string]bool{}
	next := []ManagedDocument{}
	work := []pendingDocumentIndex{}
	cancelled := false
	productPrefs := loadProductPreferences()
	unlimitedSize := loadUserSettings().DocumentsUnlimitedEnabled
	for _, root := range library.Roots {
		rootPolicy := productPrefs.DocumentPolicies[root.Path]
		if rootPolicy.Mode == "" {
			rootPolicy = DocumentRootPolicy{Mode: "semantic", MaxMB: 20, MaxPages: maxDocumentPDFPages, MaxSlides: maxDocumentPPTXSlides}
		}
		if rootPolicy.Mode == "excluded" {
			for path, old := range previous {
				if sameDocumentPath(old.Root, root.Path) {
					found[path] = true
					next = append(next, old)
				}
			}
			continue
		}
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
			for _, excluded := range library.ExcludedPaths {
				if sameDocumentPath(excluded, path) {
					return nil
				}
			}
			ext := strings.ToLower(filepath.Ext(entry.Name()))
			if !supportedDocumentExtensions[ext] || found[path] {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return nil
			}
			if info.Size() == 0 {
				return nil
			}
			a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) {
				progress.Discovered++
				progress.CurrentFile = path
			})
			rel, _ := filepath.Rel(root.Path, path)
			doc := ManagedDocument{ID: documentID(path), Root: root.Path, Path: path, RelativePath: rel, Name: entry.Name(), FileType: strings.TrimPrefix(ext, "."), Size: info.Size(), ModifiedAt: float64(info.ModTime().UnixNano()) / 1e9, Tags: []string{}, IndexStatus: "pending"}
			old, hadOld := previous[path]
			if hadOld {
				doc.Tags, doc.ContentHash, doc.IndexStatus, doc.IndexedAt, doc.Error, doc.ChunkCount = old.Tags, old.ContentHash, old.IndexStatus, old.IndexedAt, old.Error, old.ChunkCount
				unchanged := old.Size == doc.Size && old.ModifiedAt == doc.ModifiedAt
				// A limit-skip is worth retrying on an explicit Refresh:
				// the size/page/slide caps it hit may have just changed
				// (e.g. the user turned on "no limit" in Documents).
				retryableSkip := retryFailed && old.IndexStatus == "skipped" && documentIndexLimitMessage(old.Error)
				if unchanged && !retryableSkip && (old.IndexStatus == "indexed" || old.IndexStatus == "skipped" || (!retryFailed && old.IndexStatus == "failed" && !transientDocumentIndexError(old.Error))) {
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
			maxBytes := int64(rootPolicy.MaxMB) << 20
			if maxBytes <= 0 {
				maxBytes = maxDocumentFileBytes
			}
			if !unlimitedSize && info.Size() > maxBytes {
				doc.IndexStatus, doc.Error = "skipped", fmt.Sprintf("file exceeds the %d MB automatic indexing limit", maxBytes>>20)
				found[path] = true
				next = append(next, doc)
				return nil
			}
			maxPages, maxSlides := rootPolicy.MaxPages, rootPolicy.MaxSlides
			if unlimitedSize {
				maxPages, maxSlides = documentLimitUnlimited, documentLimitUnlimited
			}
			chunks, hash, extractErr := extractDocumentWithLimits(path, ext, maxPages, maxSlides)
			if extractErr != nil {
				if documentIndexLimitError(extractErr) {
					doc.IndexStatus, doc.Error = "skipped", extractErr.Error()
				} else {
					doc.IndexStatus, doc.Error = "failed", extractErr.Error()
					a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) { progress.Failed++ })
				}
				found[path] = true
				next = append(next, doc)
				return nil
			}
			if !unlimitedSize && len(chunks) > maxDocumentIndexChunks {
				doc.IndexStatus, doc.Error = "skipped", fmt.Sprintf("document creates %d chunks, exceeding the %d chunk automatic indexing limit", len(chunks), maxDocumentIndexChunks)
				found[path] = true
				next = append(next, doc)
				return nil
			}
			if hadOld && old.IndexStatus == "indexed" && old.ContentHash != "" && old.ContentHash == hash {
				doc.ContentHash, doc.IndexStatus, doc.IndexedAt, doc.Error, doc.ChunkCount = old.ContentHash, old.IndexStatus, old.IndexedAt, "", old.ChunkCount
				next = append(next, doc)
				found[path] = true
				return nil
			}
			work = append(work, pendingDocumentIndex{doc: doc, chunks: chunks, hash: hash})
			a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) { progress.Pending++; progress.TotalChunks += len(chunks) })
			found[path] = true
			return nil
		})
		if errors.Is(walkErr, context.Canceled) {
			cancelled = true
			break
		}
	}
	if !cancelled && len(work) > 0 {
		const targetBatchChunks = 64
		for start := 0; start < len(work); {
			if ctx.Err() != nil {
				cancelled = true
				break
			}
			end, chunkCount := start, 0
			for end < len(work) && (chunkCount == 0 || chunkCount+len(work[end].chunks) <= targetBatchChunks) {
				chunkCount += len(work[end].chunks)
				end++
			}
			if end == start { // one unusually large document still makes progress
				end++
			}
			currentPath := work[start].doc.Path
			a.updateDocumentScanProgress(true, func(progress *DocumentScanProgress) {
				progress.Phase, progress.CurrentFile = "embedding", currentPath
			})
			texts := make([]string, 0, chunkCount)
			for _, item := range work[start:end] {
				for _, chunk := range item.chunks {
					texts = append(texts, chunk.Text)
				}
			}
			embeddingResult, batchErr := embedDocumentChunks(ctx, texts, library.EmbeddingFingerprint)
			batchVectors := embeddingResult.Vectors
			if batchErr == nil && embeddingResult.Fingerprint != "" {
				library.EmbeddingFingerprint = embeddingResult.Fingerprint
			}
			a.updateDocumentScanProgress(true, func(progress *DocumentScanProgress) {
				progress.CacheHits += embeddingResult.CacheHits
				progress.CacheMisses += embeddingResult.CacheMisses
				progress.EmbeddingRequests += len(embeddingResult.Batches)
				for _, batch := range embeddingResult.Batches {
					progress.EmbeddingMS += batch.DurationMS
				}
				progress.EmbeddingBatches = append(progress.EmbeddingBatches, embeddingResult.Batches...)
				progress.ElapsedMS = time.Since(a.documentScanStartedAt).Milliseconds()
			})
			batchUpserted := false
			if batchErr == nil {
				batchUpserted = upsertDocumentBatch(ctx, work[start:end], batchVectors, library.EmbeddingFingerprint) == nil
			}
			offset := 0
			for _, item := range work[start:end] {
				doc := item.doc
				vectors, embedErr := [][]float64(nil), batchErr
				if batchErr == nil {
					vectors = batchVectors[offset : offset+len(item.chunks)]
				}
				a.updateDocumentScanProgress(true, func(progress *DocumentScanProgress) {
					progress.Phase, progress.CurrentFile = "indexing", doc.Path
				})
				if embedErr != nil {
					doc.IndexStatus, doc.Error = "failed", embedErr.Error()
					a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) { progress.Failed++ })
				} else if !batchUpserted {
					// A bulk write failure falls back to isolated writes so one
					// malformed document does not fail the entire micro-batch.
					if err := upsertDocument(ctx, doc, item.hash, item.chunks, vectors, library.EmbeddingFingerprint); err != nil {
						doc.IndexStatus, doc.Error = "failed", err.Error()
						a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) { progress.Failed++ })
					} else {
						doc.IndexStatus, doc.Error, doc.ContentHash, doc.IndexedAt, doc.ChunkCount = "indexed", "", item.hash, time.Now().UTC().Format(time.RFC3339), len(item.chunks)
						a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) { progress.Indexed++ })
					}
				} else {
					doc.IndexStatus, doc.Error, doc.ContentHash, doc.IndexedAt, doc.ChunkCount = "indexed", "", item.hash, time.Now().UTC().Format(time.RFC3339), len(item.chunks)
					a.updateDocumentScanProgress(false, func(progress *DocumentScanProgress) { progress.Indexed++ })
				}
				next = append(next, doc)
				offset += len(item.chunks)
			}
			if err := saveDocumentScanCheckpoint(library, next, work[end:]); err != nil {
				return DocumentSnapshot{}, false, err
			}
			start = end
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

func transientDocumentIndexError(message string) bool {
	message = strings.ToLower(message)
	return strings.Contains(message, "timeout") || strings.Contains(message, "deadline exceeded") || strings.Contains(message, "connection reset") || strings.Contains(message, "connection refused")
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

func documentChunkCacheKey(fingerprint, text string) string {
	sum := sha256.Sum256([]byte(text))
	return fingerprint + ":" + documentChunkerVersion + ":" + hex.EncodeToString(sum[:])
}

func cachedDocumentVectors(ctx context.Context, keys []string) (map[string][]float64, error) {
	result := map[string][]float64{}
	if len(keys) == 0 {
		return result, nil
	}
	should := make([]any, 0, len(keys))
	for _, key := range keys {
		should = append(should, map[string]any{"key": "embedding_cache_key", "match": map[string]any{"value": key}})
	}
	body, _ := json.Marshal(map[string]any{"limit": len(keys), "with_payload": true, "with_vector": true, "filter": map[string]any{"should": should}})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, qdrantURL+"/collections/"+documentCollection+"/points/scroll", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := documentHTTPClient(30 * time.Second).Do(req)
	if err != nil {
		return result, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return result, nil
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return result, fmt.Errorf("read document embedding cache failed: %s", responseDetail(raw))
	}
	var response struct {
		Result struct {
			Points []struct {
				Vector  []float64      `json:"vector"`
				Payload map[string]any `json:"payload"`
			} `json:"points"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return result, err
	}
	for _, point := range response.Result.Points {
		key, _ := point.Payload["embedding_cache_key"].(string)
		if key != "" && len(point.Vector) > 0 {
			result[key] = point.Vector
		}
	}
	return result, nil
}

func embedDocumentChunks(ctx context.Context, texts []string, fingerprint string) (documentEmbeddingResult, error) {
	keys := make([]string, len(texts))
	uniqueKeys := []string{}
	seen := map[string]bool{}
	for index, value := range texts {
		keys[index] = documentChunkCacheKey(fingerprint, value)
		if !seen[keys[index]] {
			seen[keys[index]] = true
			uniqueKeys = append(uniqueKeys, keys[index])
		}
	}
	cached, err := cachedDocumentVectors(ctx, uniqueKeys)
	if err != nil {
		return documentEmbeddingResult{}, err
	}
	missingKeys, missingTexts := []string{}, []string{}
	for index, key := range keys {
		if _, ok := cached[key]; !ok && !seen["missing:"+key] {
			seen["missing:"+key] = true
			missingKeys = append(missingKeys, key)
			missingTexts = append(missingTexts, texts[index])
		}
	}
	cacheHits := len(texts) - len(missingTexts)
	batches := []DocumentEmbeddingBatchMetric{}
	if len(missingTexts) > 0 {
		result, err := embedWithLongbrainResult(ctx, missingTexts)
		batches = result.Batches
		if err != nil {
			return documentEmbeddingResult{CacheHits: cacheHits, CacheMisses: len(missingTexts), Batches: result.Batches}, err
		}
		if fingerprint != "" && result.Fingerprint != fingerprint && len(cached) > 0 {
			firstBatches := result.Batches
			result, err = embedWithLongbrainResult(ctx, texts)
			result.Batches = append(firstBatches, result.Batches...)
			if err != nil {
				return documentEmbeddingResult{CacheMisses: len(texts), Batches: result.Batches}, err
			}
			result.CacheMisses = len(texts)
			return result, nil
		}
		fingerprint = result.Fingerprint
		for index, key := range missingKeys {
			cached[key] = result.Vectors[index]
		}
	}
	vectors := make([][]float64, len(keys))
	for index, key := range keys {
		vectors[index] = cached[key]
	}
	return documentEmbeddingResult{Vectors: vectors, Fingerprint: fingerprint, CacheHits: cacheHits, CacheMisses: len(missingTexts), Batches: batches}, nil
}

func embedWithLongbrainBatch(ctx context.Context, texts []string) (result documentEmbeddingResult, err error) {
	started := time.Now()
	defer func() {
		result.Batches = append(result.Batches, DocumentEmbeddingBatchMetric{Texts: len(texts), DurationMS: time.Since(started).Milliseconds()})
	}()
	data, _ := json.Marshal(map[string]any{"texts": texts, "profile": documentEmbeddingProfile, "local_only": true})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, longbrainURL+"/embeddings", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	resp, err := documentHTTPClient(5 * time.Minute).Do(req)
	if err != nil {
		return documentEmbeddingResult{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return documentEmbeddingResult{}, fmt.Errorf("LongBrain embedding failed: %s", responseDetail(raw))
	}
	var response struct {
		Vectors     [][]float64 `json:"vectors"`
		Dimension   int         `json:"dimension"`
		Fingerprint string      `json:"fingerprint"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return documentEmbeddingResult{}, fmt.Errorf("invalid LongBrain embedding response: %w", err)
	}
	if len(response.Vectors) != len(texts) {
		return documentEmbeddingResult{}, fmt.Errorf("LongBrain returned %d embeddings for %d chunks", len(response.Vectors), len(texts))
	}
	if response.Dimension <= 0 || response.Fingerprint == "" {
		return documentEmbeddingResult{}, fmt.Errorf("LongBrain embedding response is missing its vector fingerprint")
	}
	for _, vector := range response.Vectors {
		if len(vector) != response.Dimension {
			return documentEmbeddingResult{}, fmt.Errorf("LongBrain returned vector dimension %d, expected %d", len(vector), response.Dimension)
		}
	}
	return documentEmbeddingResult{Vectors: response.Vectors, Fingerprint: response.Fingerprint}, nil
}

func embedWithLongbrainResult(ctx context.Context, texts []string) (documentEmbeddingResult, error) {
	// BGE-M3 on CPU can take longer than the HTTP timeout for 64 full-sized
	// document chunks. Smaller requests also make transient retries cheaper.
	const batchSize = 16
	vectors := make([][]float64, 0, len(texts))
	fingerprint := ""
	batches := []DocumentEmbeddingBatchMetric{}
	for start := 0; start < len(texts); start += batchSize {
		end := start + batchSize
		if end > len(texts) {
			end = len(texts)
		}
		batch, err := embedWithLongbrainBatch(ctx, texts[start:end])
		if err != nil {
			return documentEmbeddingResult{Batches: append(batches, batch.Batches...)}, err
		}
		if fingerprint != "" && batch.Fingerprint != fingerprint {
			return documentEmbeddingResult{Batches: append(batches, batch.Batches...)}, fmt.Errorf("LongBrain embedding fingerprint changed during one request")
		}
		fingerprint = batch.Fingerprint
		vectors = append(vectors, batch.Vectors...)
		batches = append(batches, batch.Batches...)
	}
	return documentEmbeddingResult{Vectors: vectors, Fingerprint: fingerprint, Batches: batches}, nil
}

func embedWithLongbrain(ctx context.Context, texts []string) ([][]float64, error) {
	result, err := embedWithLongbrainResult(ctx, texts)
	return result.Vectors, err
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

func indexedDocumentChunkCount(library DocumentLibrary) int {
	total := 0
	for _, doc := range library.Documents {
		if doc.IndexStatus == "indexed" && doc.ChunkCount > 0 {
			total += doc.ChunkCount
		}
	}
	return total
}

// documentCollectionPointCount is deliberately read-only. Collection
// creation belongs to indexing, not searching: creating an empty collection
// during a search hides a lost index behind a successful empty result.
func documentCollectionPointCount(ctx context.Context) (int, error) {
	return documentCollectionFilteredPointCount(ctx, []any{
		map[string]any{"key": "project_id", "match": map[string]any{"value": documentProjectID}},
	})
}

func documentCollectionDocumentPointCount(ctx context.Context, documentID string) (int, error) {
	return documentCollectionFilteredPointCount(ctx, []any{
		map[string]any{"key": "project_id", "match": map[string]any{"value": documentProjectID}},
		map[string]any{"key": "document_id", "match": map[string]any{"value": documentID}},
	})
}

func documentCollectionFilteredPointCount(ctx context.Context, must []any) (int, error) {
	body, _ := json.Marshal(map[string]any{
		"exact":  true,
		"filter": map[string]any{"must": must},
	})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, qdrantURL+"/collections/"+documentCollection+"/points/count", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := documentHTTPClient(10 * time.Second).Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return 0, nil
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, fmt.Errorf("Qdrant count failed: %s", strings.TrimSpace(string(raw)))
	}
	var result struct {
		Result struct {
			Count int `json:"count"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return 0, err
	}
	return result.Result.Count, nil
}

func qdrantPointID(documentID, version string, chunk int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%d", documentID, version, chunk)))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[:8], h[8:12], h[12:16], h[16:20], h[20:])
}

func saveDocumentScanCheckpoint(library DocumentLibrary, completed []ManagedDocument, remaining []pendingDocumentIndex) error {
	checkpoint := library
	checkpoint.Documents = append([]ManagedDocument{}, completed...)
	for _, item := range remaining {
		checkpoint.Documents = append(checkpoint.Documents, item.doc)
	}
	sortDocuments(checkpoint.Documents)
	documentLibraryMu.Lock()
	defer documentLibraryMu.Unlock()
	return saveDocumentLibrary(checkpoint)
}

func documentQdrantPoint(doc ManagedDocument, version, fingerprint string, chunk DocumentChunk, vector []float64) map[string]any {
	payload := map[string]any{"document_id": doc.ID, "version": version, "path": doc.Path, "file_name": doc.Name, "file_type": doc.FileType, "chunk_index": chunk.ChunkIndex, "text": chunk.Text, "project_id": documentProjectID, "embedding_cache_key": documentChunkCacheKey(fingerprint, chunk.Text), "embedding_fingerprint": fingerprint, "chunker_version": documentChunkerVersion}
	if chunk.Page != nil {
		payload["page"] = *chunk.Page
	}
	if chunk.Slide != nil {
		payload["slide"] = *chunk.Slide
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
	return map[string]any{"id": qdrantPointID(doc.ID, version, chunk.ChunkIndex), "vector": vector, "payload": payload}
}

func upsertQdrantPoints(ctx context.Context, points []map[string]any) error {
	for start := 0; start < len(points); start += 64 {
		end := start + 64
		if end > len(points) {
			end = len(points)
		}
		body, _ := json.Marshal(map[string]any{"points": points[start:end]})
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
	return nil
}

func upsertDocumentBatch(ctx context.Context, items []pendingDocumentIndex, vectors [][]float64, fingerprint string) error {
	if len(vectors) == 0 {
		return fmt.Errorf("document batch has no embeddings")
	}
	if err := ensureDocumentCollection(ctx, len(vectors[0])); err != nil {
		return err
	}
	points := make([]map[string]any, 0, len(vectors))
	offset := 0
	for _, item := range items {
		if offset+len(item.chunks) > len(vectors) {
			return fmt.Errorf("document batch returned too few embeddings")
		}
		for index, chunk := range item.chunks {
			points = append(points, documentQdrantPoint(item.doc, item.hash, fingerprint, chunk, vectors[offset+index]))
		}
		offset += len(item.chunks)
	}
	if offset != len(vectors) {
		return fmt.Errorf("document batch returned %d unused embeddings", len(vectors)-offset)
	}
	if err := upsertQdrantPoints(ctx, points); err != nil {
		return err
	}
	for _, item := range items {
		filter := map[string]any{"must": []any{map[string]any{"key": "document_id", "match": map[string]any{"value": item.doc.ID}}}, "must_not": []any{map[string]any{"key": "version", "match": map[string]any{"value": item.hash}}}}
		if err := deleteQdrantFilter(ctx, filter); err != nil {
			return err
		}
	}
	return nil
}

func upsertDocument(ctx context.Context, doc ManagedDocument, version string, chunks []DocumentChunk, vectors [][]float64, fingerprint string) error {
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
			points = append(points, documentQdrantPoint(doc, version, fingerprint, chunks[i], vectors[i]))
		}
		if err := upsertQdrantPoints(ctx, points); err != nil {
			return err
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

// SearchDocuments is the exact-match mode. It never goes through vector
// search: the embedding of a shortened or reworded lexical query (file names,
// Japanese titles, IDs) can drop the target chunk out of any semantic
// candidate set, so exact mode scans every indexed chunk and matches text
// directly.
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
	return documentExactScanHits(ctx, query)
}

func (a *App) SemanticSearchDocuments(query string) ([]DocumentSearchHit, error) {
	return a.searchDocuments(query)
}

func (a *App) searchDocuments(query string) ([]DocumentSearchHit, error) {
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
	indexedPoints, err := documentCollectionPointCount(ctx)
	if err != nil {
		return nil, err
	}
	if indexedPoints == 0 {
		return nil, fmt.Errorf("document index is empty; scan documents again before searching")
	}
	// Retrieve a wider semantic candidate set, then rerank it locally with
	// literal matches. Embedding cosine similarity alone is not a calibrated
	// accuracy percentage and can rank an unrelated passage in another
	// language above a passage that actually contains the requested words.
	body, _ := json.Marshal(map[string]any{"vector": vectors[0], "limit": 100, "with_payload": true, "score_threshold": 0.1})
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
		hit := searchHitFromPayload(item.Payload, item.Score)
		hit.Score = documentSearchRelevance(query, hit, item.Score)
		hits = append(hits, hit)
	}
	if exactHits, err := documentExactAnchorHits(ctx, query); err == nil {
		hits = mergeDocumentSearchHits(hits, exactHits)
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	return diversifyDocumentSearchHits(existingDocumentSearchHits(hits), 30, 3), nil
}

func documentSearchRelevance(query string, hit DocumentSearchHit, cosine float64) float64 {
	semantic := clampDocumentScore((cosine - 0.1) / 0.9)
	lexical := documentLexicalScore(query, hit.Text, hit.Heading, hit.FileName)
	if lexical <= 0 {
		// Semantic-only matches remain useful, but do not present raw cosine as
		// an "accuracy" percentage or let it outrank a direct text match.
		return minFloat(0.74, semantic*0.74)
	}
	if lexical == 1 {
		return 0.9 + 0.1*semantic
	}
	return clampDocumentScore(0.72*lexical + 0.28*semantic)
}

func documentExactTextMatch(query, text string) bool {
	haystack := normalizedSearchText(text)
	needle := normalizedSearchText(query)
	if needle != "" && strings.Contains(haystack, needle) {
		return true
	}
	anchors := documentSearchAnchors(query)
	if len(anchors) == 0 {
		return false
	}
	// A query such as `7月リリース_AIインポート` contains multiple CJK
	// runs. Matching only one common run must not turn an absent filename into
	// a 100% exact result; every extracted anchor must be present.
	for _, anchor := range anchors {
		if !strings.Contains(haystack, anchor) && documentCJKAnchorCoverage(anchor, haystack) < 0.6 {
			return false
		}
	}
	return true
}

// documentCJKAnchorCoverage measures how much of a CJK anchor survives in the
// haystack via character-bigram overlap. Japanese/Chinese text has no word
// separators, so dropping a word from a query can join the remaining runs into
// a phrase that no longer exists verbatim anywhere.
func documentCJKAnchorCoverage(anchor, haystack string) float64 {
	runes := []rune(anchor)
	if len(runes) < 4 {
		return 0
	}
	for _, r := range runes {
		if !isDocumentCJKRune(r) {
			return 0
		}
	}
	matched := 0
	for i := 0; i+1 < len(runes); i++ {
		if strings.Contains(haystack, string(runes[i:i+2])) {
			matched++
		}
	}
	return float64(matched) / float64(len(runes)-1)
}

func documentLexicalScore(query string, values ...string) float64 {
	needle := normalizedSearchText(query)
	if needle == "" {
		return 0
	}
	haystack := normalizedSearchText(strings.Join(values, " "))
	if strings.Contains(haystack, needle) {
		return 1
	}
	if anchors := documentSearchAnchors(query); len(anchors) > 0 {
		if len(anchors) == 1 && anchors[0] == needle {
			goto termScoring
		}
		lowestCoverage := 1.0
		for _, anchor := range anchors {
			if strings.Contains(haystack, anchor) {
				continue
			}
			coverage := documentCJKAnchorCoverage(anchor, haystack)
			if coverage < 0.6 {
				return 0
			}
			if coverage < lowestCoverage {
				lowestCoverage = coverage
			}
		}
		if anchors[0] != needle {
			return 0.95 * lowestCoverage
		}
	}

termScoring:
	terms := strings.Fields(needle)
	if len(terms) == 0 {
		return 0
	}
	matched := 0
	for _, term := range terms {
		if utf8.RuneCountInString(term) >= 2 && strings.Contains(haystack, term) {
			matched++
		}
	}
	if matched == 0 {
		return 0
	}
	ratio := float64(matched) / float64(len(terms))
	if matched == len(terms) {
		return 0.9
	}
	return 0.65 * ratio
}

func documentSearchAnchors(query string) []string {
	anchors := []string{}
	seen := map[string]bool{}
	add := func(value string) {
		normalized := normalizedSearchText(value)
		if normalized == "" || seen[normalized] {
			return
		}
		if utf8.RuneCountInString(normalized) >= 2 {
			anchors = append(anchors, normalized)
			seen[normalized] = true
		}
	}
	for _, quote := range [][2]rune{{'"', '"'}, {'“', '”'}, {'「', '」'}, {'『', '』'}} {
		inQuote := false
		var quoted strings.Builder
		for _, r := range query {
			if !inQuote && r == quote[0] {
				inQuote = true
				quoted.Reset()
				continue
			}
			if inQuote && r == quote[1] {
				add(quoted.String())
				inQuote = false
				continue
			}
			if inQuote {
				quoted.WriteRune(r)
			}
		}
	}
	var cjkRun strings.Builder
	flushCJK := func() {
		if utf8.RuneCountInString(cjkRun.String()) >= 2 {
			add(cjkRun.String())
		}
		cjkRun.Reset()
	}
	for _, r := range query {
		if isDocumentCJKRune(r) {
			cjkRun.WriteRune(r)
		} else {
			flushCJK()
		}
	}
	flushCJK()
	if len(anchors) == 0 {
		add(query)
	}
	return anchors
}

func isDocumentCJKRune(r rune) bool {
	return (r >= 0x3040 && r <= 0x30ff) || (r >= 0x3400 && r <= 0x4dbf) || (r >= 0x4e00 && r <= 0x9fff) || (r >= 0xf900 && r <= 0xfaff)
}

func documentExactAnchorHits(ctx context.Context, query string) ([]DocumentSearchHit, error) {
	anchors := documentSearchAnchors(query)
	if len(anchors) == 0 || !documentShouldScrollExactAnchors(query, anchors) {
		return nil, nil
	}
	hits := []DocumentSearchHit{}
	err := documentScanCollection(ctx, func(hit DocumentSearchHit) {
		if documentExactTextMatch(query, hit.Text+" "+hit.Heading+" "+hit.FileName) {
			hit.Score = documentSearchRelevance(query, hit, 1)
			hits = append(hits, hit)
		}
	})
	if err != nil {
		return nil, err
	}
	return hits, nil
}

func documentExactScanHits(ctx context.Context, query string) ([]DocumentSearchHit, error) {
	hits := []DocumentSearchHit{}
	err := documentScanCollection(ctx, func(hit DocumentSearchHit) {
		if score := documentLexicalScore(query, hit.Text, hit.Heading, hit.FileName); score > 0 {
			hit.Score = score
			hits = append(hits, hit)
		}
	})
	if err != nil {
		return nil, err
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	hits = existingDocumentSearchHits(hits)
	if len(hits) > 30 {
		hits = hits[:30]
	}
	return hits, nil
}

func documentScanCollection(ctx context.Context, visit func(DocumentSearchHit)) error {
	var offset json.RawMessage
	for page := 0; page < 200; page++ {
		bodyMap := map[string]any{
			"limit":        256,
			"with_payload": true,
			"with_vector":  false,
			"filter": map[string]any{"must": []any{
				map[string]any{"key": "project_id", "match": map[string]any{"value": documentProjectID}},
			}},
		}
		if len(offset) > 0 && string(offset) != "null" {
			var offsetValue any
			if err := json.Unmarshal(offset, &offsetValue); err == nil {
				bodyMap["offset"] = offsetValue
			}
		}
		body, _ := json.Marshal(bodyMap)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, qdrantURL+"/collections/"+documentCollection+"/points/scroll", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := documentHTTPClient(30 * time.Second).Do(req)
		if err != nil {
			return err
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		if resp.StatusCode == http.StatusNotFound {
			return nil
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("document scan failed: %s", strings.TrimSpace(string(raw)))
		}
		var result struct {
			Result struct {
				Points []struct {
					Payload map[string]any `json:"payload"`
				} `json:"points"`
				NextPageOffset json.RawMessage `json:"next_page_offset"`
			} `json:"result"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			return err
		}
		for _, point := range result.Result.Points {
			visit(searchHitFromPayload(point.Payload, 1))
		}
		offset = result.Result.NextPageOffset
		if len(offset) == 0 || string(offset) == "null" {
			break
		}
	}
	return nil
}

func documentShouldScrollExactAnchors(query string, anchors []string) bool {
	needle := normalizedSearchText(query)
	// Short API verbs and identifiers (GET, POST, S3, JWT...) are poorly
	// represented by semantic embeddings. Always merge literal scan hits for
	// them, even when the user currently has Meaning mode selected.
	if utf8.RuneCountInString(needle) <= 4 {
		return true
	}
	for _, r := range query {
		if isDocumentCJKRune(r) {
			return true
		}
	}
	for _, anchor := range anchors {
		if anchor != needle {
			return true
		}
	}
	return false
}

// DocumentPlainText returns the already-supported local extraction of a
// managed document for explicit user copy actions. It does not query Qdrant,
// run embeddings, or send document content to LongBrain.
func (a *App) DocumentPlainText(path string) (string, error) {
	if !managedDocumentPath(path) {
		return "", fmt.Errorf("document is not in the managed library")
	}
	ext := strings.ToLower(filepath.Ext(path))
	chunks, _, err := extractDocument(path, ext)
	if err != nil {
		return "", err
	}
	var result strings.Builder
	const maxCopyBytes = 2 << 20
	for _, chunk := range chunks {
		label := ""
		if chunk.Slide != nil {
			label = fmt.Sprintf("[Slide %d]\n", *chunk.Slide)
		} else if chunk.Page != nil {
			label = fmt.Sprintf("[Page %d]\n", *chunk.Page)
		}
		addition := label + strings.TrimSpace(chunk.Text) + "\n\n"
		if result.Len()+len(addition) > maxCopyBytes {
			return "", fmt.Errorf("extracted document text exceeds the 2 MB copy limit")
		}
		result.WriteString(addition)
	}
	return strings.TrimSpace(result.String()), nil
}

func mergeDocumentSearchHits(left, right []DocumentSearchHit) []DocumentSearchHit {
	merged := append([]DocumentSearchHit{}, left...)
	indexes := map[string]int{}
	for index, hit := range merged {
		indexes[documentSearchHitKey(hit)] = index
	}
	for _, hit := range right {
		key := documentSearchHitKey(hit)
		if existing, ok := indexes[key]; ok {
			if hit.Score > merged[existing].Score {
				merged[existing] = hit
			}
			continue
		}
		indexes[key] = len(merged)
		merged = append(merged, hit)
	}
	return merged
}

func documentSearchHitKey(hit DocumentSearchHit) string {
	return hit.DocumentID + "\x00" + fmt.Sprint(hit.ChunkIndex)
}

func existingDocumentSearchHits(hits []DocumentSearchHit) []DocumentSearchHit {
	result := make([]DocumentSearchHit, 0, len(hits))
	for _, hit := range hits {
		if strings.TrimSpace(hit.Path) == "" {
			continue
		}
		if info, err := os.Stat(hit.Path); err == nil && !info.IsDir() {
			result = append(result, hit)
		}
	}
	return result
}

// diversifyDocumentSearchHits prevents a long document with many similar
// chunks from occupying the whole result page. Ranking remains score-first;
// only the number of passages contributed by one document is capped.
func diversifyDocumentSearchHits(hits []DocumentSearchHit, limit, perDocument int) []DocumentSearchHit {
	if limit <= 0 || perDocument <= 0 {
		return []DocumentSearchHit{}
	}
	result := make([]DocumentSearchHit, 0, minInt(limit, len(hits)))
	counts := map[string]int{}
	for _, hit := range hits {
		documentKey := hit.DocumentID
		if documentKey == "" {
			documentKey = norm.NFC.String(hit.Path)
		}
		if documentKey == "" {
			documentKey = norm.NFC.String(hit.FileName)
		}
		if counts[documentKey] >= perDocument {
			continue
		}
		counts[documentKey]++
		result = append(result, hit)
		if len(result) == limit {
			break
		}
	}
	return result
}

func normalizedSearchText(value string) string {
	var result strings.Builder
	space := true
	// macOS frequently exposes Japanese and accented filenames in decomposed
	// form. NFC makes visually identical query/file strings compare equally.
	for _, r := range strings.ToLower(norm.NFC.String(value)) {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			result.WriteRune(r)
			space = false
		} else if !space {
			result.WriteByte(' ')
			space = true
		}
	}
	return strings.TrimSpace(result.String())
}

func clampDocumentScore(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

func minFloat(left, right float64) float64 {
	if left < right {
		return left
	}
	return right
}

func searchHitFromPayload(p map[string]any, score float64) DocumentSearchHit {
	hit := DocumentSearchHit{DocumentID: stringValue(p["document_id"]), Path: stringValue(p["path"]), FileName: stringValue(p["file_name"]), FileType: stringValue(p["file_type"]), ChunkIndex: intValue(p["chunk_index"]), Heading: stringValue(p["heading"]), Text: stringValue(p["text"]), Score: score}
	hit.Page = optionalInt(p["page"])
	hit.Slide = optionalInt(p["slide"])
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
	question = strings.TrimSpace(question)
	if question == "" {
		return DocumentAnswer{}, fmt.Errorf("question is required")
	}
	status, err := requireLongbrainDocuments()
	if err != nil {
		return DocumentAnswer{}, err
	}
	if !status.LLMAvailable {
		return DocumentAnswer{}, fmt.Errorf("Ask AI is unavailable because LongBrain has no LLM configured")
	}
	queries := a.documentAIQueries(question)
	hits := []DocumentSearchHit{}
	for _, query := range queries {
		found, searchErr := a.searchDocuments(query)
		if searchErr != nil {
			err = searchErr
			continue
		}
		hits = mergeDocumentSearchHits(hits, found)
	}
	if len(hits) == 0 && err != nil {
		return DocumentAnswer{}, err
	}
	if len(hits) == 0 {
		return DocumentAnswer{Answer: "No relevant indexed documents were found.", Citations: []DocumentSearchHit{}}, nil
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	if len(hits) > 6 {
		hits = hits[:6]
	}
	return a.answerDocumentPassages(question, hits)
}

func (a *App) documentAIQueries(question string) []string {
	queries := []string{}
	seen := map[string]bool{}
	add := func(value string) {
		value = strings.Trim(strings.TrimSpace(value), "`\"'“”[]")
		value = strings.TrimPrefix(value, "- ")
		value = strings.TrimPrefix(value, "* ")
		if value == "" || seen[value] {
			return
		}
		queries = append(queries, value)
		seen[value] = true
	}
	add(question)
	for _, anchor := range documentSearchAnchors(question) {
		if anchor != normalizedSearchText(question) {
			add(anchor)
		}
	}
	prompt := "You are preparing document search queries. From the user's question, produce up to 5 short search queries that should retrieve the exact source passages. Include literal terms, translated equivalents, and important quoted or Japanese/CJK phrases. Return only a JSON array of strings.\n\nQuestion: " + question
	response, err := a.askLongbrain(prompt, 45*time.Second)
	if err == nil {
		for _, query := range parseDocumentQueryList(response) {
			add(query)
		}
	}
	if len(queries) > 8 {
		queries = queries[:8]
	}
	return queries
}

func (a *App) AskDocumentPassages(question string, passages []DocumentSearchHit) (DocumentAnswer, error) {
	question = strings.TrimSpace(question)
	if question == "" {
		return DocumentAnswer{}, fmt.Errorf("question is required")
	}
	status, err := requireLongbrainDocuments()
	if err != nil {
		return DocumentAnswer{}, err
	}
	if !status.LLMAvailable {
		return DocumentAnswer{}, fmt.Errorf("Ask AI is unavailable because LongBrain has no LLM configured")
	}
	hits := make([]DocumentSearchHit, 0, len(passages))
	for _, hit := range passages {
		if strings.TrimSpace(hit.Text) != "" {
			hits = append(hits, hit)
		}
	}
	if len(hits) == 0 {
		return DocumentAnswer{Answer: "No passages were selected for Ask AI.", Citations: []DocumentSearchHit{}}, nil
	}
	if len(hits) > 6 {
		hits = hits[:6]
	}
	return a.answerDocumentPassages(question, hits)
}

func parseDocumentQueryList(response string) []string {
	response = strings.TrimSpace(response)
	var values []string
	if err := json.Unmarshal([]byte(response), &values); err != nil {
		start, end := strings.Index(response, "["), strings.LastIndex(response, "]")
		if start >= 0 && end > start {
			_ = json.Unmarshal([]byte(response[start:end+1]), &values)
		}
	}
	if len(values) > 0 {
		return values
	}
	lines := strings.Split(response, "\n")
	values = make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		line = strings.TrimLeft(line, "-*0123456789.）) ")
		line = strings.Trim(line, "`\"'“”")
		if line != "" {
			values = append(values, line)
		}
	}
	return values
}

func (a *App) answerDocumentPassages(question string, hits []DocumentSearchHit) (DocumentAnswer, error) {
	var contextText strings.Builder
	for i, hit := range hits {
		fmt.Fprintf(&contextText, "[%d] %s (%s)\n%s\n\n", i+1, hit.FileName, documentLocator(hit), hit.Text)
	}
	prompt := "Answer the question using only the passages below. Cite supporting passages as [1], [2], etc. If the passages are insufficient, say so.\n\nQuestion: " + question + "\n\nPassages:\n" + contextText.String()
	status, err := requireLongbrainDocuments()
	if err != nil || !status.LLMAvailable {
		return DocumentAnswer{}, fmt.Errorf("Ask AI stopped because the configured LLM is no longer available")
	}
	answer, err := a.askLongbrain(prompt, 180*time.Second)
	if err != nil {
		return DocumentAnswer{}, err
	}
	return DocumentAnswer{Answer: answer, Citations: hits}, nil
}

func (a *App) askLongbrain(prompt string, timeout time.Duration) (string, error) {
	// Keep the public /completion request provider-neutral. Some LongBrain
	// adapters (notably Gemini) cannot accept generation options as direct
	// generate_content arguments, so let LongBrain apply its own defaults.
	payload, _ := json.Marshal(map[string]any{"prompt": prompt, "local_only": false})
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, longbrainURL+"/completion", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	resp, err := documentHTTPClient(timeout).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("LongBrain AI is unavailable: %s", responseDetail(raw))
	}
	var result struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", err
	}
	if strings.TrimSpace(result.Text) == "" {
		return "", fmt.Errorf("LongBrain AI returned an empty completion")
	}
	return result.Text, nil
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
// GetDocumentsOCREnabled reports whether image-only PDF pages get an OCR
// fallback (via Vision) during Documents indexing.
func (a *App) GetDocumentsOCREnabled() bool {
	return loadUserSettings().DocumentsOCREnabled
}

// SetDocumentsOCREnabled turns the OCR fallback on or off. Turning it on
// does not retroactively re-scan already-failed PDFs on its own — the
// background poll only retries "failed" documents on the next explicit
// Refresh (or app restart), not on its once-a-minute automatic pass.
func (a *App) SetDocumentsOCREnabled(enabled bool) error {
	settings := loadUserSettings()
	settings.DocumentsOCREnabled = enabled
	return saveUserSettings(settings)
}

// GetDocumentsUnlimitedEnabled reports whether the automatic indexing
// page/slide-count and file-size caps are bypassed for every folder.
func (a *App) GetDocumentsUnlimitedEnabled() bool {
	return loadUserSettings().DocumentsUnlimitedEnabled
}

// SetDocumentsUnlimitedEnabled turns that bypass on or off. Same retry
// caveat as SetDocumentsOCREnabled: previously "skipped" documents are
// only re-evaluated on an explicit Refresh (or app restart).
func (a *App) SetDocumentsUnlimitedEnabled(enabled bool) error {
	settings := loadUserSettings()
	settings.DocumentsUnlimitedEnabled = enabled
	return saveUserSettings(settings)
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
	return extractDocumentWithLimits(path, ext, maxDocumentPDFPages, maxDocumentPPTXSlides)
}

func extractDocumentWithLimits(path, ext string, maxPages, maxSlides int) ([]DocumentChunk, string, error) {
	// PDFKit reads PDFs directly from disk. Hash them as a stream instead of
	// loading another full copy into RAM first; the file-size cap (skipped
	// entirely when DocumentsUnlimitedEnabled is on) is enforced by the
	// caller before this is ever reached.
	if ext == ".pdf" {
		hash, err := hashDocumentFile(path)
		if err != nil {
			return nil, "", err
		}
		if maxPages == 0 {
			maxPages = maxDocumentPDFPages
		}
		ocrEnabled := loadUserSettings().DocumentsOCREnabled
		pages, err := extractPDFPages(path, maxPages, ocrEnabled)
		if err != nil {
			return nil, "", err
		}
		chunks := chunkPages(pages)
		if len(chunks) == 0 {
			if ocrEnabled {
				return nil, "", fmt.Errorf("PDF contains no extractable text — OCR found no text on any page")
			}
			return nil, "", fmt.Errorf("PDF contains no extractable text; enable OCR for image-only PDFs in Documents")
		}
		return chunks, hash, nil
	}
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
	case ".pptx":
		chunks, err = extractPPTXWithLimit(data, maxSlides)
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

func documentIndexLimitError(err error) bool {
	if err == nil {
		return false
	}
	return documentIndexLimitMessage(err.Error())
}

func documentIndexLimitMessage(message string) bool {
	message = strings.ToLower(message)
	// "is limited to" matches the chunk-count skip message's older wording
	// ("... automatic indexing is limited to N") — still recognized so
	// documents already persisted with that exact text (from before the
	// wording was made consistent with the other limit messages) are still
	// retried on an explicit Refresh, not stuck "skipped" forever.
	return strings.Contains(message, "indexing limit") || strings.Contains(message, "automatic indexing limit") || strings.Contains(message, "is limited to")
}

func hashDocumentFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
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
			if file.UncompressedSize64 > maxDocumentExpandedXMLBytes {
				return nil, fmt.Errorf("DOCX document XML exceeds the automatic indexing limit")
			}
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

func extractPPTX(data []byte) ([]DocumentChunk, error) {
	return extractPPTXWithLimit(data, maxDocumentPPTXSlides)
}

func extractPPTXWithLimit(data []byte, maxSlides int) ([]DocumentChunk, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("invalid PPTX: %w", err)
	}
	type slideFile struct {
		number int
		file   *zip.File
	}
	slides := []slideFile{}
	var expandedSlideBytes uint64
	for _, file := range reader.File {
		name := file.Name
		if !strings.HasPrefix(name, "ppt/slides/slide") || !strings.HasSuffix(name, ".xml") || strings.Contains(name, "_rels/") {
			continue
		}
		numberText := strings.TrimSuffix(strings.TrimPrefix(name, "ppt/slides/slide"), ".xml")
		number, numberErr := strconv.Atoi(numberText)
		if numberErr == nil && number > 0 {
			expandedSlideBytes += file.UncompressedSize64
			if expandedSlideBytes > maxDocumentExpandedXMLBytes {
				return nil, fmt.Errorf("PPTX slide XML exceeds the automatic indexing limit")
			}
			slides = append(slides, slideFile{number: number, file: file})
		}
	}
	if len(slides) == 0 {
		return nil, fmt.Errorf("PPTX contains no slides")
	}
	sort.Slice(slides, func(i, j int) bool { return slides[i].number < slides[j].number })
	if maxSlides == 0 {
		maxSlides = maxDocumentPPTXSlides
	}
	if maxSlides > 0 && len(slides) > maxSlides {
		return nil, fmt.Errorf("PPTX exceeds the %d slide automatic indexing limit", maxSlides)
	}
	chunks := []DocumentChunk{}
	for _, slide := range slides {
		text, textErr := extractPPTXSlideText(slide.file)
		if textErr != nil {
			return nil, fmt.Errorf("read PPTX slide %d: %w", slide.number, textErr)
		}
		for _, part := range splitText(text, maxDocumentChunk) {
			value := strings.TrimSpace(part)
			if value == "" {
				continue
			}
			number := slide.number
			chunks = append(chunks, DocumentChunk{Text: value, ChunkIndex: len(chunks), Slide: &number})
		}
	}
	return chunks, nil
}

func extractPPTXSlideText(file *zip.File) (string, error) {
	stream, err := file.Open()
	if err != nil {
		return "", err
	}
	defer stream.Close()
	decoder := xml.NewDecoder(stream)
	paragraphs := []string{}
	var paragraph strings.Builder
	inText := false
	for {
		token, tokenErr := decoder.Token()
		if tokenErr == io.EOF {
			break
		}
		if tokenErr != nil {
			return "", tokenErr
		}
		switch value := token.(type) {
		case xml.StartElement:
			if value.Name.Local == "t" {
				inText = true
			}
		case xml.CharData:
			if inText {
				paragraph.Write([]byte(value))
			}
		case xml.EndElement:
			if value.Name.Local == "t" {
				inText = false
			}
			if value.Name.Local == "p" {
				if text := strings.TrimSpace(paragraph.String()); text != "" {
					paragraphs = append(paragraphs, text)
				}
				paragraph.Reset()
			}
		}
	}
	if text := strings.TrimSpace(paragraph.String()); text != "" {
		paragraphs = append(paragraphs, text)
	}
	return strings.Join(paragraphs, "\n"), nil
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
