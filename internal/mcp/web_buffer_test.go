package mcp

import (
	"encoding/json"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

func resetWebBuffersForTest() {
	webBufferMu.Lock()
	defer webBufferMu.Unlock()
	webBuffers = make(map[string]*userWebBuffer)
}

func TestBufferedWebToolFlow(t *testing.T) {
	resetWebBuffersForTest()
	content := strings.Repeat("general introduction text ", 55) +
		"The compatibility marker is gateway-buffer-contract. " +
		strings.Repeat("closing text ", 40)

	handle, err := bufferToolResult("tester", "read_web_page", "compatibility", "https://example.com/docs", "Compatibility", content)
	if err != nil {
		t.Fatalf("bufferToolResult returned error: %v", err)
	}
	match := regexp.MustCompile(`Source ID: (src_[0-9a-f]+)`).FindStringSubmatch(handle)
	if len(match) != 2 {
		t.Fatalf("source handle missing source ID: %q", handle)
	}
	if strings.Contains(handle, content) {
		t.Fatal("source handle unexpectedly contains the full buffered content")
	}

	arguments, err := json.Marshal(map[string]interface{}{
		"source_id":  match[1],
		"query":      "gateway-buffer-contract",
		"max_chunks": 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := ExecuteToolByName("read_buffered_source", arguments, "tester", false, nil)
	if err != nil {
		t.Fatalf("readBufferedToolSource returned error: %v", err)
	}
	if !strings.Contains(result, "gateway-buffer-contract") {
		t.Fatalf("focused buffered result omitted the matching passage: %q", result)
	}
}

func TestBufferedSourceToolIsEnabled(t *testing.T) {
	for _, tool := range GetToolList() {
		if tool.Name == "read_buffered_source" {
			return
		}
	}
	t.Fatal("read_buffered_source is not exposed by GetToolList")
}

func TestTimedToolCacheExpiresEntries(t *testing.T) {
	cache := make(map[string]timedToolCacheEntry)
	var mu sync.Mutex
	setTimedToolCache(cache, &mu, "query", "result", time.Minute)
	if result, ok := getTimedToolCache(cache, &mu, "query", time.Minute); !ok || result != "result" {
		t.Fatalf("cache miss for fresh entry: result=%q ok=%v", result, ok)
	}

	mu.Lock()
	entry := cache["query"]
	entry.StoredAt = time.Now().Add(-2 * time.Minute)
	cache["query"] = entry
	mu.Unlock()
	if _, ok := getTimedToolCache(cache, &mu, "query", time.Minute); ok {
		t.Fatal("expired cache entry was returned")
	}
}
