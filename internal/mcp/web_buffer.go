package mcp

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	webBufferChunkSize    = 1000
	webBufferChunkOverlap = 150
	webBufferMaxPerUser   = 24
)

// BufferedWebChunk and BufferedWebSource intentionally mirror the lightweight
// in-memory portion of the app tool package. The terminal assistant does not
// need Gateway's SQLite/embedding storage, but it keeps the same source-handle
// contract so tool prompts and callers can behave consistently in both apps.
type BufferedWebChunk struct {
	Index       int
	Text        string
	FTSScore    float64
	VectorScore float64
	HybridScore float64
}

type BufferedWebSource struct {
	SourceID   string
	UserID     string
	ToolName   string
	Query      string
	URL        string
	Title      string
	Summary    string
	Content    string
	Chunks     []BufferedWebChunk
	FetchedAt  time.Time
	LastUsedAt time.Time
}

type userWebBuffer struct {
	Sources map[string]*BufferedWebSource
	Order   []string
}

var (
	webBufferMu sync.RWMutex
	webBuffers  = make(map[string]*userWebBuffer)
)

func init() {
	SetToolHooks(ToolHooks{
		BufferWebResult: func(userID, toolName, query, pageURL, title, content string) (string, error) {
			source := saveBufferedWebSource(userID, toolName, query, pageURL, title, content)
			return formatBufferedSourceHandle(source), nil
		},
		BufferWebFallback: func(userID, failedTool, target string, err error) string {
			return formatBufferedFallbackAfterToolError(userID, failedTool, target, err)
		},
		ReadBufferedSource: func(userID, sourceID, query string, maxChunks int) (string, error) {
			return readBufferedSource(userID, sourceID, query, maxChunks)
		},
		NormalizeSearchQuery:    defaultNormalizeSearchQuery,
		ReadPageTimeoutForURL:   readPageTimeoutForToolURL,
		ChallengeWaitIterations: challengeWaitIterationsForTool,
	})
}

func normalizeBufferedUserID(userID string) string {
	if userID = strings.TrimSpace(userID); userID == "" {
		return "default"
	}
	return userID
}

func saveBufferedWebSource(userID, toolName, query, pageURL, title, content string) *BufferedWebSource {
	userID = normalizeBufferedUserID(userID)
	content = strings.TrimSpace(content)
	now := time.Now()
	if strings.TrimSpace(title) == "" {
		title = inferBufferedTitle(pageURL, query, content)
	}

	source := &BufferedWebSource{
		SourceID:   fmt.Sprintf("src_%x", now.UnixNano()),
		UserID:     userID,
		ToolName:   strings.TrimSpace(toolName),
		Query:      strings.TrimSpace(query),
		URL:        strings.TrimSpace(pageURL),
		Title:      strings.TrimSpace(title),
		Summary:    summarizeBufferedContent(content),
		Content:    content,
		Chunks:     chunkBufferedContent(content, webBufferChunkSize, webBufferChunkOverlap),
		FetchedAt:  now,
		LastUsedAt: now,
	}

	webBufferMu.Lock()
	defer webBufferMu.Unlock()

	buffer := webBuffers[userID]
	if buffer == nil {
		buffer = &userWebBuffer{Sources: make(map[string]*BufferedWebSource)}
		webBuffers[userID] = buffer
	}
	buffer.Sources[source.SourceID] = source
	buffer.Order = append(buffer.Order, source.SourceID)

	for len(buffer.Order) > webBufferMaxPerUser {
		oldest := buffer.Order[0]
		buffer.Order = buffer.Order[1:]
		delete(buffer.Sources, oldest)
	}

	emitTraceEvent("tool_runtime", "buffer.saved", "Buffered web source saved", traceDetailsMap(
		"tool", source.ToolName,
		"user", source.UserID,
		"source_id", source.SourceID,
		"chars", len(source.Content),
		"chunks", len(source.Chunks),
		"storage", "memory",
	))
	return source
}

func getBufferedWebSource(userID, sourceID string) (*BufferedWebSource, error) {
	userID = normalizeBufferedUserID(userID)
	webBufferMu.Lock()
	defer webBufferMu.Unlock()

	buffer := webBuffers[userID]
	if buffer == nil || len(buffer.Order) == 0 {
		return nil, fmt.Errorf("no buffered web sources available")
	}

	if sourceID = strings.TrimSpace(sourceID); sourceID == "" {
		sourceID = buffer.Order[len(buffer.Order)-1]
	}
	source := buffer.Sources[sourceID]
	if source == nil {
		return nil, fmt.Errorf("buffered source not found: %s", sourceID)
	}
	source.LastUsedAt = time.Now()
	return source, nil
}

func summarizeBufferedContent(content string) string {
	lines := strings.FieldsFunc(content, func(r rune) bool { return r == '\n' || r == '\r' })
	picked := make([]string, 0, 3)
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		picked = append(picked, line)
		if len(strings.Join(picked, " ")) > 320 || len(picked) >= 3 {
			break
		}
	}
	if len(picked) == 0 {
		return compactMemoryText(content, 280)
	}
	return compactMemoryText(strings.Join(picked, " "), 280)
}

func inferBufferedTitle(pageURL, query, content string) string {
	for _, line := range strings.FieldsFunc(content, func(r rune) bool { return r == '\n' || r == '\r' }) {
		if line = strings.TrimSpace(line); len([]rune(line)) >= 8 {
			return compactMemoryText(line, 120)
		}
	}
	if query = strings.TrimSpace(query); query != "" {
		return fmt.Sprintf("Search: %s", compactMemoryText(query, 80))
	}
	if pageURL = strings.TrimSpace(pageURL); pageURL != "" {
		if parsed, err := url.Parse(pageURL); err == nil && parsed.Hostname() != "" {
			return parsed.Hostname()
		}
		return compactMemoryText(pageURL, 120)
	}
	return "Buffered Web Source"
}

func chunkBufferedContent(content string, chunkSize, overlap int) []BufferedWebChunk {
	runes := []rune(strings.TrimSpace(content))
	if len(runes) == 0 {
		return nil
	}
	if chunkSize <= 0 {
		chunkSize = webBufferChunkSize
	}
	if overlap < 0 || overlap >= chunkSize {
		overlap = 0
	}

	step := chunkSize - overlap
	chunks := make([]BufferedWebChunk, 0, (len(runes)+step-1)/step)
	for start := 0; start < len(runes); start += step {
		end := start + chunkSize
		if end > len(runes) {
			end = len(runes)
		}
		if text := strings.TrimSpace(string(runes[start:end])); text != "" {
			chunks = append(chunks, BufferedWebChunk{Index: len(chunks), Text: text})
		}
		if end == len(runes) {
			break
		}
	}
	return chunks
}

func formatBufferedSourceHandle(source *BufferedWebSource) string {
	if source == nil {
		return "Buffered web source unavailable."
	}
	var b strings.Builder
	b.WriteString("Buffered Web Source Saved\n")
	fmt.Fprintf(&b, "Source ID: %s\n", source.SourceID)
	if source.Title != "" {
		fmt.Fprintf(&b, "Title: %s\n", source.Title)
	}
	if source.Query != "" {
		fmt.Fprintf(&b, "Query: %s\n", source.Query)
	}
	if source.URL != "" {
		fmt.Fprintf(&b, "URL: %s\n", source.URL)
	}
	fmt.Fprintf(&b, "Summary: %s\n", source.Summary)
	b.WriteString("Full content is buffered server-side for this user. Use read_buffered_source with source_id and a focused query before answering in detail.")
	return b.String()
}

func formatBufferedFallbackAfterToolError(userID, failedTool, target string, toolErr error) string {
	source, err := getBufferedWebSource(userID, "")
	if err != nil {
		return fmt.Sprintf("%s failed for %q: %v. Do not retry the same request immediately.", failedTool, strings.TrimSpace(target), toolErr)
	}
	return fmt.Sprintf(
		"%s failed for %q: %v. Use buffered source %s instead. Summary: %s",
		failedTool,
		strings.TrimSpace(target),
		toolErr,
		source.SourceID,
		source.Summary,
	)
}

func readBufferedSource(userID, sourceID, query string, maxChunks int) (string, error) {
	source, err := getBufferedWebSource(userID, sourceID)
	if err != nil {
		return "", err
	}
	if maxChunks <= 0 {
		maxChunks = 3
	}
	if maxChunks > 6 {
		maxChunks = 6
	}

	selected := selectRelevantBufferedChunks(source, query, maxChunks)
	if len(selected) == 0 {
		return "", fmt.Errorf("no buffered passages available")
	}

	var b strings.Builder
	b.WriteString("Buffered Web Source\n")
	fmt.Fprintf(&b, "Source ID: %s\n", source.SourceID)
	fmt.Fprintf(&b, "Title: %s\n", source.Title)
	if source.URL != "" {
		fmt.Fprintf(&b, "URL: %s\n", source.URL)
	}
	if strings.TrimSpace(query) != "" {
		fmt.Fprintf(&b, "Focus Query: %s\n", strings.TrimSpace(query))
	}
	fmt.Fprintf(&b, "Summary: %s\n\nRelevant Excerpts:\n", source.Summary)
	for _, chunk := range selected {
		fmt.Fprintf(&b, "\n[Chunk %d]\n%s\n", chunk.Index+1, chunk.Text)
	}

	emitTraceEvent("tool_runtime", "buffer.read", "Buffered web source excerpts selected", traceDetailsMap(
		"tool", "read_buffered_source",
		"user", normalizeBufferedUserID(userID),
		"source_id", source.SourceID,
		"selected_chunks", len(selected),
		"storage", "memory",
	))
	return strings.TrimSpace(b.String()), nil
}

func selectRelevantBufferedChunks(source *BufferedWebSource, query string, maxChunks int) []BufferedWebChunk {
	if source == nil || len(source.Chunks) == 0 {
		return nil
	}
	if maxChunks > len(source.Chunks) {
		maxChunks = len(source.Chunks)
	}
	terms := tokenizeBufferedQuery(query)
	if len(terms) == 0 {
		return append([]BufferedWebChunk(nil), source.Chunks[:maxChunks]...)
	}

	type scoredChunk struct {
		chunk BufferedWebChunk
		score int
	}
	scored := make([]scoredChunk, 0, len(source.Chunks))
	for _, chunk := range source.Chunks {
		if score := scoreBufferedChunk(chunk.Text, terms); score > 0 {
			scored = append(scored, scoredChunk{chunk: chunk, score: score})
		}
	}
	if len(scored) == 0 {
		return append([]BufferedWebChunk(nil), source.Chunks[:maxChunks]...)
	}
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].score == scored[j].score {
			return scored[i].chunk.Index < scored[j].chunk.Index
		}
		return scored[i].score > scored[j].score
	})
	if len(scored) > maxChunks {
		scored = scored[:maxChunks]
	}
	sort.SliceStable(scored, func(i, j int) bool { return scored[i].chunk.Index < scored[j].chunk.Index })

	selected := make([]BufferedWebChunk, 0, len(scored))
	for _, item := range scored {
		selected = append(selected, item.chunk)
	}
	return selected
}

func tokenizeBufferedQuery(query string) []string {
	fields := strings.Fields(strings.ToLower(strings.TrimSpace(query)))
	terms := make([]string, 0, len(fields))
	seen := make(map[string]struct{})
	for _, field := range fields {
		field = strings.Trim(field, ".,!?;:()[]{}\"'")
		if len([]rune(field)) < 2 {
			continue
		}
		if _, exists := seen[field]; exists {
			continue
		}
		seen[field] = struct{}{}
		terms = append(terms, field)
	}
	return terms
}

func scoreBufferedChunk(text string, terms []string) int {
	text = strings.ToLower(text)
	score := 0
	for _, term := range terms {
		if strings.Contains(text, term) {
			score += 2
		}
	}
	return score
}
