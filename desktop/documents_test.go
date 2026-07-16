package main

import (
	"archive/zip"
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestDocumentCollectionIsIsolated(t *testing.T) {
	if documentCollection != "thaloca_documents" {
		t.Fatalf("unexpected collection %q", documentCollection)
	}
	if documentCollection == "longbrain_documents" {
		t.Fatal("Thaloca must not share LongBrain's batch document collection")
	}
}

func TestDocumentsRequireLongbrainAndQdrant(t *testing.T) {
	for _, test := range []struct {
		name   string
		status LongbrainDocumentStatus
		ready  bool
	}{
		{name: "neither available", status: LongbrainDocumentStatus{}, ready: false},
		{name: "LongBrain only", status: LongbrainDocumentStatus{Healthy: true}, ready: false},
		{name: "Qdrant only", status: LongbrainDocumentStatus{QdrantHealthy: true}, ready: false},
		{name: "runtime ready but external embedding", status: LongbrainDocumentStatus{Healthy: true, QdrantHealthy: true}, ready: false},
		{name: "all local", status: LongbrainDocumentStatus{Healthy: true, QdrantHealthy: true, EmbeddingLocal: true}, ready: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := longbrainDocumentsAvailable(test.status); got != test.ready {
				t.Fatalf("availability = %v, want %v", got, test.ready)
			}
		})
	}
}

func TestDocumentProvidersFailClosed(t *testing.T) {
	for _, provider := range []string{"fastembed", "sentence-transformers", "sentence_transformers"} {
		if !localEmbeddingProvider(provider) {
			t.Errorf("expected embedding provider %q to be local", provider)
		}
	}
	for _, provider := range []string{"", "openai", "gemini", "cohere", "unknown"} {
		if localEmbeddingProvider(provider) {
			t.Errorf("expected embedding provider %q to be blocked", provider)
		}
	}
	for _, provider := range []string{"ollama", "llamacpp", "llama.cpp", "mlx", "lmstudio"} {
		if !localLLMProvider(provider) {
			t.Errorf("expected LLM provider %q to be local", provider)
		}
	}
	for _, provider := range []string{"", "openai", "gemini", "anthropic", "unknown"} {
		if localLLMProvider(provider) {
			t.Errorf("expected LLM provider %q to be blocked", provider)
		}
	}
}

func TestEmbeddingConfigurationChangeRequiresReindex(t *testing.T) {
	status := LongbrainDocumentStatus{EmbeddingProvider: "fastembed", EmbeddingModel: "new-model"}
	if documentEmbeddingConfigurationChanged(DocumentLibrary{}, status) {
		t.Fatal("empty library should not require reindex")
	}
	library := DocumentLibrary{Documents: []ManagedDocument{{ID: "one"}}, EmbeddingProvider: "fastembed", EmbeddingModel: "old-model"}
	if !documentEmbeddingConfigurationChanged(library, status) {
		t.Fatal("model change was not detected")
	}
	library.EmbeddingModel = "new-model"
	if documentEmbeddingConfigurationChanged(library, status) {
		t.Fatal("matching embedding configuration should not require reindex")
	}
}

func TestGeneratedAndDependencyDirectoriesAreSkipped(t *testing.T) {
	for _, name := range []string{".git", "node_modules", "vendor", "dist", "build", "Pods"} {
		if !shouldSkipDocumentDirectory(name) {
			t.Errorf("expected %q to be skipped", name)
		}
	}
	for _, name := range []string{"docs", "notes", "product-build-notes"} {
		if shouldSkipDocumentDirectory(name) {
			t.Errorf("expected %q to remain scannable", name)
		}
	}
}

func TestChunkLinesKeepsSourceLocation(t *testing.T) {
	chunks := chunkLines("first line\nsecond line\nthird line")
	if len(chunks) != 1 || chunks[0].LineStart == nil || *chunks[0].LineStart != 1 || chunks[0].LineEnd == nil || *chunks[0].LineEnd != 3 {
		t.Fatalf("unexpected chunks: %+v", chunks)
	}
}

func TestSplitTextUsesRuneBoundaries(t *testing.T) {
	chunks := splitText("Một tài liệu tiếng Việt có dấu", 8)
	if len(chunks) < 2 || strings.Contains(strings.Join(chunks, ""), "�") {
		t.Fatalf("invalid unicode chunks: %#v", chunks)
	}
	if strings.Join(chunks, "") != "Một tài liệu tiếng Việt có dấu" {
		t.Fatalf("content changed: %#v", chunks)
	}
}

func TestExtractDOCXParagraphs(t *testing.T) {
	var data bytes.Buffer
	writer := zip.NewWriter(&data)
	file, err := writer.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	_, err = file.Write([]byte(`<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>Alpha</w:t></w:r></w:p><w:p><w:r><w:t>Beta</w:t></w:r></w:p></w:body></w:document>`))
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	chunks, err := extractDOCX(data.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) != 1 || chunks[0].Text != "Alpha\nBeta" || chunks[0].ParagraphEnd == nil || *chunks[0].ParagraphEnd != 2 {
		t.Fatalf("unexpected DOCX chunks: %+v", chunks)
	}
}

func TestDocumentIDsAreStableAndDistinct(t *testing.T) {
	if documentID("/tmp/a.md") != documentID("/tmp/a.md") {
		t.Fatal("document ID is not stable")
	}
	if documentID("/tmp/a.md") == documentID("/tmp/b.md") {
		t.Fatal("different paths share an ID")
	}
	first := qdrantPointID("doc", "v1", 0)
	if first != qdrantPointID("doc", "v1", 0) || first == qdrantPointID("doc", "v1", 1) {
		t.Fatal("invalid point ID behavior")
	}
}

func TestCancelDocumentScan(t *testing.T) {
	a := &App{}
	ctx, started := a.beginDocumentScan()
	if !started || !a.CancelDocumentScan() {
		t.Fatal("scan did not start or cancel")
	}
	if a.documentScanProgress.Phase != "cancelling" {
		t.Fatalf("unexpected cancel phase %q", a.documentScanProgress.Phase)
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("scan context was not cancelled")
	}
	a.finishDocumentScan(true)
	if a.isDocumentScanning() {
		t.Fatal("scan remained active")
	}
	if a.documentScanProgress.Phase != "cancelled" {
		t.Fatalf("unexpected final phase %q", a.documentScanProgress.Phase)
	}
}

func TestDocumentLongbrainIntegration(t *testing.T) {
	if os.Getenv("THALOCA_DOCUMENT_INTEGRATION") != "1" {
		t.Skip("set THALOCA_DOCUMENT_INTEGRATION=1 with LongBrain running")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	vectors, err := embedWithLongbrain(ctx, []string{"Thaloca isolated document integration sentinel"})
	if err != nil {
		t.Fatal(err)
	}
	doc := ManagedDocument{ID: "thaloca-integration-test", Path: "/tmp/thaloca-integration.md", Name: "thaloca-integration.md", FileType: "md"}
	defer deleteDocumentIndex(context.Background(), doc.ID)
	chunks := []DocumentChunk{{Text: "Thaloca isolated document integration sentinel", ChunkIndex: 0}}
	if err := upsertDocument(ctx, doc, "test-version", chunks, vectors); err != nil {
		t.Fatal(err)
	}
}
