package health

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPCheck(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	result := New().Check(context.Background(), server.URL)
	if result.State != "healthy" || result.StatusCode != http.StatusNoContent {
		t.Fatalf("Check() = %+v", result)
	}
}

func TestHTTPCheckReportsServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	result := New().Check(context.Background(), server.URL)
	if result.State != "down" {
		t.Fatalf("Check() = %+v", result)
	}
}
