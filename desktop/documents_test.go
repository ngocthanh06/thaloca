package main

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
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

func TestPrepareDocumentEmbeddingMigrationReindexesWithoutDeleting(t *testing.T) {
	library := DocumentLibrary{
		EmbeddingProvider: "old", EmbeddingModel: "old-model", EmbeddingDimension: 1024, EmbeddingFingerprint: "old:old-model:1024",
		Documents: []ManagedDocument{{ID: "doc-1", IndexStatus: "indexed", ContentHash: "hash", IndexedAt: "yesterday", ChunkCount: 3}},
	}
	status := LongbrainDocumentStatus{EmbeddingProvider: "local", EmbeddingModel: "new-model", EmbeddingDimension: 1024, EmbeddingFingerprint: "local:new-model:1024"}
	if err := prepareDocumentEmbeddingMigration(&library, status); err != nil {
		t.Fatal(err)
	}
	doc := library.Documents[0]
	if doc.IndexStatus != "pending" || doc.ContentHash != "" || doc.ChunkCount != 0 || library.EmbeddingFingerprint != status.EmbeddingFingerprint {
		t.Fatalf("migration was not resumable: library=%#v doc=%#v", library, doc)
	}
}

func TestPrepareDocumentEmbeddingMigrationPreservesIncompatibleIndex(t *testing.T) {
	library := DocumentLibrary{EmbeddingDimension: 768, EmbeddingFingerprint: "local:old:768", Documents: []ManagedDocument{{IndexStatus: "indexed", ContentHash: "hash", ChunkCount: 2}}}
	err := prepareDocumentEmbeddingMigration(&library, LongbrainDocumentStatus{EmbeddingDimension: 1024, EmbeddingFingerprint: "local:new:1024"})
	if err == nil || library.Documents[0].IndexStatus != "indexed" || library.Documents[0].ContentHash != "hash" {
		t.Fatalf("incompatible migration must preserve the old index: library=%#v err=%v", library, err)
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
	for _, provider := range []string{"fastembed", "huggingface", "ollama", "sentence-transformers", "sentence_transformers"} {
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

func TestDocumentsUseDedicatedEmbeddingProfile(t *testing.T) {
	if documentEmbeddingProfile != "document" {
		t.Fatalf("document embedding profile = %q, want document", documentEmbeddingProfile)
	}
}

func TestDocumentIndexLimitErrorsAreSkipped(t *testing.T) {
	if !documentIndexLimitError(fmt.Errorf("PDF exceeds the 200 page automatic indexing limit")) {
		t.Fatal("page limit must be treated as a skipped document")
	}
	if documentIndexLimitError(fmt.Errorf("temporary embedding timeout")) {
		t.Fatal("temporary failures must remain retryable failures")
	}
}

func TestDocumentChunkCacheKeyIncludesFingerprintAndChunker(t *testing.T) {
	first := documentChunkCacheKey("model:a:1024", "same chunk")
	if first != documentChunkCacheKey("model:a:1024", "same chunk") {
		t.Fatal("chunk cache key must be deterministic")
	}
	if first == documentChunkCacheKey("model:b:1024", "same chunk") {
		t.Fatal("model fingerprint must isolate cached vectors")
	}
	if first == documentChunkCacheKey("model:a:1024", "changed chunk") {
		t.Fatal("chunk text hash must isolate cached vectors")
	}
	if !strings.Contains(first, documentChunkerVersion) {
		t.Fatal("chunker version is missing from cache key")
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

func TestEmbeddingFingerprintTakesPriority(t *testing.T) {
	library := DocumentLibrary{
		Documents:         []ManagedDocument{{ID: "one"}},
		EmbeddingProvider: "fastembed", EmbeddingModel: "same-model",
		EmbeddingFingerprint: "fastembed:same-model:384",
	}
	status := LongbrainDocumentStatus{
		EmbeddingProvider: "fastembed", EmbeddingModel: "same-model",
		EmbeddingDimension:   1024,
		EmbeddingFingerprint: "fastembed:same-model:1024",
	}
	if !documentEmbeddingConfigurationChanged(library, status) {
		t.Fatal("fingerprint dimension change must require reindex")
	}
	library.EmbeddingFingerprint = "" // legacy libraries fall back compatibly
	if documentEmbeddingConfigurationChanged(library, status) {
		t.Fatal("legacy provider/model match must not force an unexpected reindex")
	}
}

func TestGlobalProviderDoesNotInvalidateDocumentFingerprint(t *testing.T) {
	library := DocumentLibrary{
		Documents:            []ManagedDocument{{ID: "one"}},
		EmbeddingProvider:    "huggingface",
		EmbeddingModel:       "BAAI/bge-m3",
		EmbeddingDimension:   1024,
		EmbeddingFingerprint: "huggingface:BAAI/bge-m3:1024",
	}
	// Older LongBrain /health responses expose only the global provider
	// (fastembed). Thaloca must not synthesize a document fingerprint from it.
	status := LongbrainDocumentStatus{
		EmbeddingProvider:  "fastembed",
		EmbeddingModel:     "BAAI/bge-m3",
		EmbeddingDimension: 1024,
	}
	if documentEmbeddingConfigurationChanged(library, status) {
		t.Fatal("global fastembed provider must not invalidate a huggingface document index")
	}
	status.EmbeddingFingerprint = "huggingface:BAAI/bge-m3:1024"
	if documentEmbeddingConfigurationChanged(library, status) {
		t.Fatal("matching document provider fingerprint must remain stable")
	}
	status.EmbeddingFingerprint = "ollama:BAAI/bge-m3:1024"
	if !documentEmbeddingConfigurationChanged(library, status) {
		t.Fatal("an explicit document provider change must require reindex")
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

func TestDocumentScanSupportsOfficeAndTextFormatsButExcludesImages(t *testing.T) {
	for _, extension := range []string{".png", ".jpg", ".jpeg", ".gif", ".webp"} {
		if supportedDocumentExtensions[extension] {
			t.Errorf("expected %q to be excluded from document scans", extension)
		}
	}
	for _, extension := range []string{".pdf", ".pptx", ".docx", ".txt", ".md", ".markdown"} {
		if !supportedDocumentExtensions[extension] {
			t.Errorf("expected %q to remain supported", extension)
		}
	}
}

func TestExtractPPTXKeepsSlideNumbersAndTextOrder(t *testing.T) {
	var data bytes.Buffer
	archive := zip.NewWriter(&data)
	for name, body := range map[string]string{
		"ppt/slides/slide2.xml": `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>`,
		"ppt/slides/slide1.xml": `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Title</a:t></a:r><a:r><a:t> one</a:t></a:r></a:p><a:p><a:r><a:t>Body text</a:t></a:r></a:p></p:sld>`,
	} {
		file, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	chunks, err := extractPPTX(data.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) != 2 || chunks[0].Slide == nil || *chunks[0].Slide != 1 || chunks[1].Slide == nil || *chunks[1].Slide != 2 {
		t.Fatalf("unexpected PPTX chunks: %+v", chunks)
	}
	if chunks[0].Text != "Title one\nBody text" || chunks[1].Text != "Second slide" {
		t.Fatalf("unexpected PPTX text: %+v", chunks)
	}
}

func TestSemanticSearchFallsBackToExactScanForShortIdentifiers(t *testing.T) {
	anchors := documentSearchAnchors("GET")
	if len(anchors) == 0 || !documentShouldScrollExactAnchors("GET", anchors) {
		t.Fatalf("short identifier did not enable exact fallback: %#v", anchors)
	}
	if !documentExactTextMatch("GET", "メソッド: GET パラメータ: sso") {
		t.Fatal("GET was not matched in extracted PPTX text")
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

func TestDocumentPathsAreNormalizedForRemoval(t *testing.T) {
	base := t.TempDir()
	if !sameDocumentPath(base+string(os.PathSeparator)+".", base) {
		t.Fatal("equivalent document root paths did not match")
	}
	if sameDocumentPath(base, base+"-other") {
		t.Fatal("different document root paths matched")
	}
}

func TestDocumentSearchRerankingPrefersLiteralMatches(t *testing.T) {
	query := "xóa thư mục"
	direct := DocumentSearchHit{Text: "Chức năng xóa thư mục khỏi Documents."}
	unrelatedJapanese := DocumentSearchHit{Text: "これは別の日本語の文書です。"}
	directScore := documentSearchRelevance(query, direct, 0.42)
	unrelatedScore := documentSearchRelevance(query, unrelatedJapanese, 0.91)
	if directScore <= unrelatedScore {
		t.Fatalf("literal match score %.3f should beat unrelated semantic score %.3f", directScore, unrelatedScore)
	}
	if directScore < 0.8 {
		t.Fatalf("literal match score %.3f is unexpectedly low", directScore)
	}
}

func TestDocumentSearchRerankingSupportsUnicode(t *testing.T) {
	if score := documentLexicalScore("設定を削除", "この画面で設定を削除できます"); score != 1 {
		t.Fatalf("Japanese phrase score = %.3f, want 1", score)
	}
	if score := documentLexicalScore("tìm kiếm chính xác", "Tìm kiếm CHÍNH XÁC trong tài liệu"); score != 1 {
		t.Fatalf("Vietnamese phrase score = %.3f, want 1", score)
	}
}

func TestDocumentSearchNormalizesEquivalentUnicode(t *testing.T) {
	composed := "エラーメッセージ表示"
	decomposed := "エラーメッセーシ\u3099表示"
	if normalizedSearchText(composed) != normalizedSearchText(decomposed) {
		t.Fatal("canonically equivalent Japanese text did not normalize equally")
	}
	if !documentExactTextMatch(composed, decomposed+"の修正指示書") {
		t.Fatal("exact search missed canonically equivalent Japanese text")
	}
}

func TestDiversifyDocumentSearchHitsCapsPassagesPerDocument(t *testing.T) {
	hits := []DocumentSearchHit{
		{DocumentID: "a", ChunkIndex: 0, Score: .99},
		{DocumentID: "a", ChunkIndex: 1, Score: .98},
		{DocumentID: "a", ChunkIndex: 2, Score: .97},
		{DocumentID: "b", ChunkIndex: 0, Score: .96},
		{DocumentID: "c", ChunkIndex: 0, Score: .95},
	}
	got := diversifyDocumentSearchHits(hits, 4, 2)
	if len(got) != 4 {
		t.Fatalf("diversified result count = %d, want 4", len(got))
	}
	if got[0].DocumentID != "a" || got[1].DocumentID != "a" || got[2].DocumentID != "b" || got[3].DocumentID != "c" {
		t.Fatalf("unexpected diversified order: %#v", got)
	}
}

func TestDocumentExactSearchRejectsUnmatchedLanguages(t *testing.T) {
	if !documentExactTextMatch("đính", "Tài liệu có từ đính kèm") {
		t.Fatal("exact Vietnamese text match was rejected")
	}
	if documentExactTextMatch("đính", "これは別の日本語の文書です") {
		t.Fatal("unmatched Japanese passage was accepted")
	}
	if documentExactTextMatch("xóa thư mục", "thư mục này có thể xóa") {
		t.Fatal("out-of-order words must not count as an exact phrase")
	}
}

func TestDocumentExactSearchKeepsNonConsecutiveTermMatches(t *testing.T) {
	passage := "Task T-102: thay đổi message hiển thị khi validation thất bại."
	if documentLexicalScore("thay đổi message validation", passage) <= 0 {
		t.Fatal("passage containing every query term must stay in exact results")
	}
	if documentLexicalScore("message validation thất bại là task nào?", passage) <= 0 {
		t.Fatal("question wording must not hide a passage containing the key terms")
	}
	if documentLexicalScore("cấu hình proxy mạng", passage) > 0 {
		t.Fatal("passage without any query term must stay filtered out")
	}
}

func TestDocumentSearchAnchorsMixedLanguageQuestion(t *testing.T) {
	query := "cái gì mà thay đổi message thành バリデーション失敗時の表示文言を差し替えます là ở task nào?"
	if !documentExactTextMatch(query, "Task 42: バリデーション失敗時の表示文言を差し替えます") {
		t.Fatal("mixed-language query did not match its Japanese anchor")
	}
	if documentExactTextMatch(query, "Task khác chỉ nói về thay đổi message") {
		t.Fatal("Vietnamese filler words must not count as the exact anchor")
	}
	direct := DocumentSearchHit{Text: "Task 42: バリデーション失敗時の表示文言を差し替えます"}
	unrelated := DocumentSearchHit{Text: "Task khác chỉ nói về thay đổi message"}
	if documentSearchRelevance(query, direct, 0.2) <= documentSearchRelevance(query, unrelated, 0.95) {
		t.Fatal("Japanese anchor match should outrank unrelated high-semantic passage")
	}
}

func TestDocumentSearchAnchorsDroppedCJKWords(t *testing.T) {
	fileName := "7月リリース_AIインポート検証.xlsx"
	if !documentExactTextMatch("7月リリース_AIインポート検証", fileName) {
		t.Fatal("full query did not match the file name")
	}
	if !documentExactTextMatch("7月リリース_AI", fileName) {
		t.Fatal("query with trailing words removed did not match the file name")
	}
	if !documentExactTextMatch("7月リリース検証", fileName) {
		t.Fatal("query with a middle word removed did not match via CJK bigram coverage")
	}
	if documentExactTextMatch("7月リリース検証", "これは別の日本語の文書です") {
		t.Fatal("unrelated Japanese passage must stay rejected")
	}
	if documentLexicalScore("7月リリース検証", fileName) <= 0 {
		t.Fatal("joined CJK anchor must keep a positive lexical score")
	}
}

func TestDocumentExactSearchRequiresEveryCJKAnchor(t *testing.T) {
	query := "7月リリース_AIインポート"
	if documentExactTextMatch(query, "7月リリースの予定だけを説明する文書") {
		t.Fatal("one common CJK anchor must not satisfy the whole exact query")
	}
	if documentLexicalScore(query, "7月リリースの予定だけを説明する文書") != 0 {
		t.Fatal("partial CJK anchor match must not receive an exact-search score")
	}
	if !documentExactTextMatch(query, "7月リリース AIインポート検証") {
		t.Fatal("all CJK anchors present should remain an exact match")
	}
}

func TestExistingDocumentSearchHitsDropsDeletedFiles(t *testing.T) {
	existing := filepath.Join(t.TempDir(), "existing.md")
	if err := os.WriteFile(existing, []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(t.TempDir(), "missing.md")
	hits := existingDocumentSearchHits([]DocumentSearchHit{{Path: missing}, {Path: existing}})
	if len(hits) != 1 || hits[0].Path != existing {
		t.Fatalf("existing hits = %#v, want only %s", hits, existing)
	}
}

func TestIndexedDocumentChunkCountOnlyIncludesIndexedDocuments(t *testing.T) {
	library := DocumentLibrary{Documents: []ManagedDocument{
		{IndexStatus: "indexed", ChunkCount: 3},
		{IndexStatus: "pending", ChunkCount: 7},
		{IndexStatus: "indexed", ChunkCount: 2},
	}}
	if got := indexedDocumentChunkCount(library); got != 5 {
		t.Fatalf("indexedDocumentChunkCount() = %d, want 5", got)
	}
}

func TestTransientDocumentIndexError(t *testing.T) {
	if !transientDocumentIndexError(`Post "http://localhost:8800/embeddings": context deadline exceeded (Client.Timeout exceeded while awaiting headers)`) {
		t.Fatal("expected embedding timeout to be retried")
	}
	if transientDocumentIndexError("unsupported document format") {
		t.Fatal("permanent extraction errors must not be retried automatically")
	}
}

func TestParseDocumentQueryList(t *testing.T) {
	jsonQueries := parseDocumentQueryList(`["thay đổi message", "表示文言 差し替え"]`)
	if len(jsonQueries) != 2 || jsonQueries[1] != "表示文言 差し替え" {
		t.Fatalf("unexpected JSON query parse: %#v", jsonQueries)
	}
	listQueries := parseDocumentQueryList("- đổi nội dung\n- バリデーション失敗時の表示文言")
	if len(listQueries) != 2 || listQueries[0] != "đổi nội dung" {
		t.Fatalf("unexpected list query parse: %#v", listQueries)
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

func TestRenameDocumentFolderOnlyChangesDisplayName(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, "documents")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	library := DocumentLibrary{
		Roots:     []DocumentRoot{{Path: root, AddedAt: "2026-07-19T00:00:00Z"}},
		Documents: []ManagedDocument{{ID: "doc-1", Root: root, Path: filepath.Join(root, "plan.md"), Name: "plan.md", IndexStatus: "indexed", ChunkCount: 2}},
	}
	if err := saveDocumentLibrary(library); err != nil {
		t.Fatal(err)
	}
	if _, err := (&App{}).RenameDocumentFolder(root, "Tài liệu chính"); err != nil {
		t.Fatal(err)
	}
	got := loadDocumentLibrary()
	if got.Roots[0].Name != "Tài liệu chính" {
		t.Fatalf("root name = %q", got.Roots[0].Name)
	}
	if len(got.Documents) != 1 || got.Documents[0].ChunkCount != 2 || got.Documents[0].IndexStatus != "indexed" {
		t.Fatalf("rename changed indexed documents: %#v", got.Documents)
	}
}

func TestPreviewDocumentRejectsUnmanagedPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := saveDocumentLibrary(DocumentLibrary{}); err != nil {
		t.Fatal(err)
	}
	if err := (&App{}).PreviewDocument(filepath.Join(home, "private.pptx")); err == nil || !strings.Contains(err.Error(), "not in the managed library") {
		t.Fatalf("unexpected preview result: %v", err)
	}
}

func TestDocumentLongbrainIntegration(t *testing.T) {
	if os.Getenv("THALOCA_DOCUMENT_INTEGRATION") != "1" {
		t.Skip("set THALOCA_DOCUMENT_INTEGRATION=1 with LongBrain running")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	embedding, err := embedWithLongbrainResult(ctx, []string{"Thaloca isolated document integration sentinel"})
	if err != nil {
		t.Fatal(err)
	}
	if len(embedding.Batches) != 1 || embedding.Batches[0].Texts != 1 || embedding.Fingerprint == "" {
		t.Fatalf("missing embedding request metrics: %+v", embedding)
	}
	vectors := embedding.Vectors
	doc := ManagedDocument{ID: "thaloca-integration-test", Path: "/tmp/thaloca-integration.md", Name: "thaloca-integration.md", FileType: "md"}
	defer deleteDocumentIndex(context.Background(), doc.ID)
	chunks := []DocumentChunk{{Text: "Thaloca isolated document integration sentinel", ChunkIndex: 0}}
	if err := upsertDocument(ctx, doc, "test-version", chunks, vectors, "test:model:1"); err != nil {
		t.Fatal(err)
	}
}
