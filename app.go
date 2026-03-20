/*
   Created by DINKIssTyle on 2026.
   Copyright (C) 2026 DINKI'ssTyle. All rights reserved.
*/

package main

import (
	"bufio"
	"bytes"
	"context"
	"dkst-terminal-assistant/mcp"
	"dkst-terminal-assistant/terminal"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func normalizeShortcutTokens(keys []string) []string {
	normalized := make([]string, 0, len(keys))
	for _, key := range keys {
		token := strings.ToUpper(strings.TrimSpace(key))
		if token == "" {
			continue
		}
		switch token {
		case "CONTROL":
			token = "CTRL"
		case "COMMAND", "META", "OS", "SUPER", "WIN", "WINDOWS":
			token = "CMD"
		}
		normalized = append(normalized, token)
	}
	return normalized
}

func isAppNewTabShortcut(keys []string) bool {
	normalized := normalizeShortcutTokens(keys)
	hasModifier := false
	hasShift := false
	hasT := false

	for _, token := range normalized {
		switch token {
		case "CTRL", "CMD":
			hasModifier = true
		case "SHIFT":
			hasShift = true
		case "T":
			hasT = true
		}
	}

	return hasModifier && hasShift && hasT
}

func appTabSwitchIndex(keys []string) (int, bool) {
	normalized := normalizeShortcutTokens(keys)
	hasModifier := false
	digit := ""

	for _, token := range normalized {
		switch token {
		case "CTRL", "CMD":
			hasModifier = true
		case "0", "1", "2", "3", "4", "5", "6", "7", "8", "9":
			digit = token
		}
	}

	if !hasModifier || digit == "" {
		return 0, false
	}

	if digit == "0" {
		return 9, true
	}

	return int(digit[0] - '1'), true
}

func ctrlByteForToken(token string) (byte, bool) {
	normalized := strings.ToUpper(strings.TrimSpace(token))
	switch {
	case strings.HasPrefix(normalized, "CTRL_") && len(normalized) == len("CTRL_")+1:
		return normalized[len("CTRL_")] & 0x1f, true
	case strings.HasPrefix(normalized, "^") && len(normalized) == 2:
		return normalized[1] & 0x1f, true
	default:
		return 0, false
	}
}

func encodeTerminalKeys(keys []string) (string, error) {
	var builder strings.Builder

	for _, key := range keys {
		normalized := strings.ToUpper(strings.TrimSpace(key))
		if ctrlByte, ok := ctrlByteForToken(normalized); ok {
			builder.WriteByte(ctrlByte)
			continue
		}
		switch normalized {
		case "ESC":
			builder.WriteByte(0x1b)
		case "ENTER", "RETURN":
			builder.WriteByte('\r')
		case "TAB":
			builder.WriteByte('\t')
		case "SPACE":
			builder.WriteByte(' ')
		case "BACKSPACE":
			builder.WriteByte(0x7f)
		case "CTRL_C":
			builder.WriteByte(0x03)
		case "CTRL_D":
			builder.WriteByte(0x04)
		case "CTRL_Z":
			builder.WriteByte(0x1a)
		case "UP":
			builder.WriteString("\x1b[A")
		case "DOWN":
			builder.WriteString("\x1b[B")
		case "RIGHT":
			builder.WriteString("\x1b[C")
		case "LEFT":
			builder.WriteString("\x1b[D")
		default:
			if key == "" {
				return "", fmt.Errorf("empty key sequence")
			}
			if normalized == "CTRL" || normalized == "SHIFT" || normalized == "CMD" || normalized == "ALT" || normalized == "OPTION" {
				continue
			}
			builder.WriteString(key)
		}
	}

	return builder.String(), nil
}

func trimMatchingQuotes(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) < 2 {
		return trimmed
	}

	if (trimmed[0] == '\'' && trimmed[len(trimmed)-1] == '\'') || (trimmed[0] == '"' && trimmed[len(trimmed)-1] == '"') {
		return trimmed[1 : len(trimmed)-1]
	}

	return trimmed
}

func unwrapWindowsPowerShellCommand(command string) string {
	trimmed := strings.TrimSpace(command)
	lower := strings.ToLower(trimmed)
	prefixes := []string{
		"powershell -command",
		"powershell.exe -command",
		"pwsh -command",
		"pwsh.exe -command",
	}

	for _, prefix := range prefixes {
		if strings.HasPrefix(lower, prefix) {
			return trimMatchingQuotes(trimmed[len(prefix):])
		}
	}

	return trimmed
}

func normalizeCommandForTerminal(command string) string {
	normalized := strings.TrimSpace(command)
	if normalized == "" {
		return normalized
	}

	// Models often emit heredoc bodies as literal "\n" sequences on a single line.
	// Convert them back to real newlines before writing to the PTY so EOF terminators
	// can be recognized by the shell.
	if strings.Contains(normalized, "<<") && strings.Contains(normalized, `\n`) && !strings.Contains(normalized, "\n") {
		normalized = strings.ReplaceAll(normalized, `\n`, "\n")
	}

	return normalized
}

func normalizeAPIBaseURL(raw string) string {
	normalized := strings.TrimSpace(raw)
	if normalized == "" {
		return normalized
	}
	if !strings.HasPrefix(normalized, "http://") && !strings.HasPrefix(normalized, "https://") {
		normalized = "http://" + normalized
	}
	return strings.TrimSuffix(normalized, "/")
}

func emitLLMProgress(ctx context.Context, phase string, label string, percent int, active bool) {
	runtime.EventsEmit(ctx, "llm:status", map[string]interface{}{
		"phase":   phase,
		"label":   label,
		"percent": percent,
		"active":  active,
	})
}

func readProgressPercent(eventData map[string]interface{}) int {
	raw, ok := eventData["progress"]
	if !ok {
		return 0
	}

	switch value := raw.(type) {
	case float64:
		return int(value * 100)
	case float32:
		return int(value * 100)
	case int:
		return value
	default:
		return 0
	}
}

func terminalCommandSuffix() string {
	return "\r"
}

var ansiEscapePattern = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

type llmMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
	Name    string `json:"name,omitempty"`
}

func stripANSIEscapeCodes(value string) string {
	cleaned := ansiEscapePattern.ReplaceAllString(value, "")
	cleaned = strings.ReplaceAll(cleaned, "\x1b]0;", "")
	return strings.TrimSpace(cleaned)
}

func parseLLMMessages(messages []interface{}) []llmMessage {
	parsed := make([]llmMessage, 0, len(messages))
	for _, raw := range messages {
		switch msg := raw.(type) {
		case map[string]interface{}:
			role, _ := msg["role"].(string)
			content, _ := msg["content"].(string)
			name, _ := msg["name"].(string)
			parsed = append(parsed, llmMessage{
				Role:    strings.TrimSpace(role),
				Content: content,
				Name:    strings.TrimSpace(name),
			})
		case llmMessage:
			parsed = append(parsed, msg)
		}
	}
	return parsed
}

func buildLMStudioNativePayload(modelName string, maxTokens int, temperature float64, isStreaming bool, messages []interface{}) map[string]interface{} {
	parsed := parseLLMMessages(messages)
	systemPrompt := ""
	var transcriptParts []string

	for _, msg := range parsed {
		content := strings.TrimSpace(msg.Content)
		if content == "" {
			continue
		}

		if msg.Role == "system" && systemPrompt == "" {
			systemPrompt = content
			continue
		}

		roleLabel := "User"
		switch msg.Role {
		case "assistant":
			roleLabel = "Assistant"
		case "tool":
			if msg.Name != "" {
				roleLabel = fmt.Sprintf("Tool (%s)", msg.Name)
			} else {
				roleLabel = "Tool"
			}
		case "system":
			roleLabel = "System"
		}

		transcriptParts = append(transcriptParts, fmt.Sprintf("%s:\n%s", roleLabel, content))
	}

	input := strings.TrimSpace(strings.Join(transcriptParts, "\n\n"))
	if input == "" {
		input = "(empty conversation)"
	}

	payload := map[string]interface{}{
		"model":             modelName,
		"input":             input,
		"stream":            isStreaming,
		"temperature":       temperature,
		"max_output_tokens": maxTokens,
		"store":             false,
	}

	if systemPrompt != "" {
		payload["system_prompt"] = systemPrompt
	}

	return payload
}

// App struct
type App struct {
	ctx               context.Context
	terminals         map[string]*terminal.Terminal
	activeTabId       string
	mcpPort           int
	mcpLabel          string
	mcpServer         *MCPServer
	lastCommandCursor map[string]int
	mu                sync.Mutex
	cancelFunc        context.CancelFunc
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		terminals:         make(map[string]*terminal.Terminal),
		lastCommandCursor: make(map[string]int),
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// Register the terminal executor for MCP tools
	mcp.TerminalExecutor = func(command string) (string, error) {
		a.mu.Lock()
		activeId := a.activeTabId
		a.mu.Unlock()

		if activeId == "" {
			return "", fmt.Errorf("no active terminal tab")
		}

		normalized := strings.TrimSpace(command)
		if normalized == "" {
			return "", fmt.Errorf("command cannot be empty")
		}

		normalized = unwrapWindowsPowerShellCommand(normalized)
		normalized = normalizeCommandForTerminal(normalized)

		a.mu.Lock()
		term := a.terminals[activeId]
		if term != nil {
			a.lastCommandCursor[activeId] = term.OutputCursor()
		}
		a.mu.Unlock()

		if err := a.WriteToTerminal(activeId, normalized+terminalCommandSuffix()); err != nil {
			return "", err
		}

		return fmt.Sprintf("Sent to terminal: %s", normalized), nil
	}
	mcp.TerminalKeyExecutor = func(keys []string) (string, error) {
		if isAppNewTabShortcut(keys) {
			runtime.EventsEmit(a.ctx, "app:new-tab")
			return fmt.Sprintf("Opened a new app tab via shortcut %v", keys), nil
		}
		if tabIndex, ok := appTabSwitchIndex(keys); ok {
			runtime.EventsEmit(a.ctx, "app:switch-tab", tabIndex)
			return fmt.Sprintf("Switched to app tab index %d via shortcut %v", tabIndex, keys), nil
		}

		a.mu.Lock()
		activeId := a.activeTabId
		a.mu.Unlock()

		if activeId == "" {
			return "", fmt.Errorf("no active terminal tab")
		}

		encoded, err := encodeTerminalKeys(keys)
		if err != nil {
			return "", err
		}

		if err := a.WriteToTerminal(activeId, encoded); err != nil {
			return "", err
		}

		return fmt.Sprintf("Keys %v sent to active terminal (Tab ID: %s)", keys, activeId), nil
	}
	mcp.TerminalTailReader = func(lines int, maxWaitMs int, idleMs int) (string, error) {
		return a.ReadActiveTerminalTail(lines, maxWaitMs, idleMs)
	}
}

// StartTerminal starts the shell process for a specific ID
func (a *App) StartTerminal(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if _, exists := a.terminals[id]; exists {
		return fmt.Errorf("terminal session %s already exists", id)
	}

	term := terminal.NewTerminal(func(data string) {
		runtime.EventsEmit(a.ctx, "terminal:data:"+id, data)
	})

	if err := term.Start(); err != nil {
		return err
	}

	a.terminals[id] = term
	return nil
}

// WriteToTerminal writes data to the PTY of a specific ID
func (a *App) WriteToTerminal(id, data string) error {
	a.mu.Lock()
	term, exists := a.terminals[id]
	a.mu.Unlock()

	if !exists {
		return fmt.Errorf("terminal session %s not found", id)
	}
	return term.Write(data)
}

// ResizeTerminal resizes the PTY of a specific ID
func (a *App) ResizeTerminal(id string, cols, rows int) error {
	a.mu.Lock()
	term, exists := a.terminals[id]
	a.mu.Unlock()

	if !exists {
		return fmt.Errorf("terminal session %s not found", id)
	}
	return term.Resize(cols, rows)
}

// StopTerminal stops a specific terminal session
func (a *App) StopTerminal(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	term, exists := a.terminals[id]
	if !exists {
		return nil
	}

	term.Stop()
	delete(a.terminals, id)
	delete(a.lastCommandCursor, id)
	return nil
}

// SetActiveTab sets the currently active terminal tab ID
func (a *App) SetActiveTab(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.activeTabId = id
}

func (a *App) ReadActiveTerminalTail(lines int, maxWaitMs int, idleMs int) (string, error) {
	a.mu.Lock()
	activeId := a.activeTabId
	term, exists := a.terminals[activeId]
	cursor := a.lastCommandCursor[activeId]
	a.mu.Unlock()

	if activeId == "" || !exists {
		return "", fmt.Errorf("no active terminal tab")
	}

	if idleMs <= 0 {
		idleMs = 1200
	}
	if maxWaitMs < 0 {
		maxWaitMs = 0
	}

	deadline := time.Now().Add(time.Duration(maxWaitMs) * time.Millisecond)
	sawNewOutput := term.HasOutputSince(cursor)
	for maxWaitMs > 0 {
		if !sawNewOutput {
			sawNewOutput = term.HasOutputSince(cursor)
		}
		if sawNewOutput && term.TimeSinceLastOutput() >= time.Duration(idleMs)*time.Millisecond {
			break
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}

	tail := stripANSIEscapeCodes(term.TailLinesSince(lines, cursor))
	if tail == "" {
		return "(no recent terminal output)", nil
	}

	return tail, nil
}

// UpdateMCPSettings updates the internal MCP server configuration
func (a *App) UpdateMCPSettings(port int, label string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.mcpPort != port || a.mcpServer == nil {
		if port > 0 {
			if a.mcpServer != nil {
				a.mcpServer.Stop()
			}
			a.mcpPort = port
			a.mcpServer = NewMCPServer(a)
			a.mcpServer.Start(port)
		}
	}
	a.mcpLabel = label
	log.Printf("[App] MCP Settings updated: Port=%d, Label=%s", port, label)
}

func (a *App) handleMCPServerStart() {
	if a.mcpPort > 0 && a.mcpServer == nil {
		a.mcpServer = NewMCPServer(a)
		a.mcpServer.Start(a.mcpPort)
	}
}

// GetTools returns the list of available MCP tools
func (a *App) GetTools() []mcp.Tool {
	return mcp.GetToolList()
}

// CallTool executes an MCP tool
func (a *App) CallTool(name string, arguments string) (string, error) {
	return mcp.ExecuteToolByName(name, arguments)
}

// StopLLMResponse cancels the current LLM request
func (a *App) StopLLMResponse() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancelFunc != nil {
		a.cancelFunc()
		a.cancelFunc = nil
		log.Println("[App] LLM Response stopped by user")
	}
}

// FetchLLMResponse makes a call to the local or remote LLM API
func (a *App) FetchLLMResponse(apiURL string, apiKey string, modelName string, maxTokens int, temperature float64, provider string, isStreaming bool, messages []interface{}) (string, error) {
	log.Printf("[LLM] Fetching response from %s (Model: %s, Streaming: %v)", apiURL, modelName, isStreaming)
	// Cancel any existing request before starting a new one
	a.StopLLMResponse()

	ctx, cancel := context.WithCancel(a.ctx)
	a.mu.Lock()
	a.cancelFunc = cancel
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.cancelFunc = nil
		a.mu.Unlock()
		cancel()
	}()

	url := normalizeAPIBaseURL(apiURL)
	payload := map[string]interface{}{}

	if provider == "LM Studio" {
		url = strings.TrimSuffix(url, "/") + "/api/v1/chat"
		payload = buildLMStudioNativePayload(modelName, maxTokens, temperature, isStreaming, messages)
	} else {
		if provider == "Ollama" || provider == "OpenAI" {
			if !strings.HasSuffix(url, "/v1") && !strings.HasSuffix(url, "/v1/") {
				url = strings.TrimSuffix(url, "/") + "/v1"
			}
		}

		url = strings.TrimSuffix(url, "/") + "/chat/completions"
		payload = map[string]interface{}{
			"model":       modelName,
			"messages":    messages,
			"max_tokens":  maxTokens,
			"temperature": temperature,
			"stream":      isStreaming,
		}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[LLM] Request failed: %v", err)
		return "", err
	}
	defer resp.Body.Close()
	log.Printf("[LLM] Received response status: %s", resp.Status)

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("API Error (%s): %s", resp.Status, string(respBody))
	}

	if isStreaming {
		scanner := bufio.NewScanner(resp.Body)
		fullContent := ""
		currentEventType := ""
		log.Printf("[LLM] Starting SSE stream scanner...")
		for scanner.Scan() {
			line := scanner.Text()
			log.Printf("[LLM] RAW LINE: %s", line)

			if line == "" {
				continue
			}

			if strings.HasPrefix(line, "event: ") {
				currentEventType = strings.TrimSpace(strings.TrimPrefix(line, "event: "))
				continue
			}

			if !strings.HasPrefix(line, "data: ") {
				continue
			}

			data := strings.TrimPrefix(line, "data: ")
			if data == "[DONE]" {
				log.Printf("[LLM] Stream received [DONE]")
				emitLLMProgress(a.ctx, "", "", 100, false)
				break
			}

			if currentEventType != "" {
				var eventData map[string]interface{}
				if err := json.Unmarshal([]byte(data), &eventData); err == nil {
					switch currentEventType {
					case "model_load.start":
						emitLLMProgress(a.ctx, "model-load", "Loading Model...", 0, true)
						currentEventType = ""
						continue
					case "model_load.progress":
						pct := readProgressPercent(eventData)
						emitLLMProgress(a.ctx, "model-load", fmt.Sprintf("Loading Model... %d%%", pct), pct, true)
						currentEventType = ""
						continue
					case "model_load.end":
						emitLLMProgress(a.ctx, "model-load", "Model Loaded", 100, true)
						currentEventType = ""
						continue
					case "prompt_processing.start":
						emitLLMProgress(a.ctx, "prompt-processing", "Processing Prompt...", 0, true)
						currentEventType = ""
						continue
					case "prompt_processing.progress":
						pct := readProgressPercent(eventData)
						emitLLMProgress(a.ctx, "prompt-processing", fmt.Sprintf("Processing Prompt... %d%%", pct), pct, true)
						currentEventType = ""
						continue
					case "prompt_processing.end":
						emitLLMProgress(a.ctx, "prompt-processing", "Prompt Processed", 100, true)
						currentEventType = ""
						continue
					case "chat.end":
						if outputItems, ok := eventData["output"].([]interface{}); ok && fullContent == "" {
							var parts []string
							for _, item := range outputItems {
								entry, ok := item.(map[string]interface{})
								if !ok {
									continue
								}
								itemType, _ := entry["type"].(string)
								if itemType != "message" {
									continue
								}
								content, _ := entry["content"].(string)
								content = strings.TrimSpace(content)
								if content != "" {
									parts = append(parts, content)
								}
							}
							if len(parts) > 0 {
								fullContent = strings.Join(parts, "\n\n")
							}
						}
						emitLLMProgress(a.ctx, "", "", 100, false)
						currentEventType = ""
						continue
					case "message.delta":
						if content, ok := eventData["content"].(string); ok && content != "" {
							fullContent += content
							runtime.EventsEmit(a.ctx, "llm:chunk", content)
							currentEventType = ""
							continue
						}
					case "reasoning.delta":
						if reasoning, ok := eventData["content"].(string); ok && reasoning != "" {
							runtime.EventsEmit(a.ctx, "llm:thinking", reasoning)
							currentEventType = ""
							continue
						}
					}
				}
			}

			var chunk struct {
				Choices []struct {
					Delta struct {
						Content          string `json:"content"`
						ReasoningContent string `json:"reasoning_content"`
					} `json:"delta"`
				} `json:"choices"`
			}

			if err := json.Unmarshal([]byte(data), &chunk); err != nil {
				log.Printf("[LLM] JSON Parse Error: %v | Data: %s", err, data)
				continue
			}

			if len(chunk.Choices) > 0 {
				delta := chunk.Choices[0].Delta
				if delta.ReasoningContent != "" {
					runtime.EventsEmit(a.ctx, "llm:thinking", delta.ReasoningContent)
				}
				if delta.Content != "" {
					fullContent += delta.Content
					runtime.EventsEmit(a.ctx, "llm:chunk", delta.Content)
				}
			}
			currentEventType = ""
		}
		if err := scanner.Err(); err != nil {
			log.Printf("[LLM] Scanner error: %v", err)
		}
		log.Printf("[LLM] Stream complete. Total length: %d", len(fullContent))
		emitLLMProgress(a.ctx, "", "", 100, false)
		return fullContent, nil
	}

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}

	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", fmt.Errorf("JSON Parsing Error: %v (Body: %s)", err, string(respBody))
	}

	if len(result.Choices) > 0 {
		return result.Choices[0].Message.Content, nil
	}

	return "", fmt.Errorf("empty response from LLM")
}

func (a *App) FetchAvailableModels(apiURL string, apiKey string) ([]string, error) {
	endpoint := normalizeAPIBaseURL(apiURL)
	endpoint = strings.TrimSuffix(endpoint, "/v1")
	modelEndpoints := []string{
		endpoint + "/v1/models",
		endpoint + "/api/v1/models",
	}

	client := &http.Client{Timeout: 10 * time.Second}
	var lastErr error

	for _, modelsURL := range modelEndpoints {
		log.Printf("[App] Fetching models from: %s", modelsURL)

		req, err := http.NewRequest("GET", modelsURL, nil)
		if err != nil {
			lastErr = fmt.Errorf("failed to create request for %s: %v", modelsURL, err)
			continue
		}

		if apiKey != "" {
			req.Header.Set("Authorization", "Bearer "+apiKey)
		}

		resp, err := client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("connection failed for %s: %v", modelsURL, err)
			continue
		}

		bodyBytes, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("failed to read body from %s: %v", modelsURL, readErr)
			continue
		}

		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("server returned HTTP %d from %s: %s", resp.StatusCode, modelsURL, string(bodyBytes))
			continue
		}

		var result struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}

		if err := json.Unmarshal(bodyBytes, &result); err != nil {
			lastErr = fmt.Errorf("failed to parse models JSON from %s: %v", modelsURL, err)
			continue
		}

		models := make([]string, 0, len(result.Data))
		for _, m := range result.Data {
			if strings.TrimSpace(m.ID) == "" {
				continue
			}
			models = append(models, m.ID)
		}

		log.Printf("[App] Successfully fetched %d models from %s", len(models), modelsURL)
		return models, nil
	}

	if lastErr != nil {
		return nil, lastErr
	}

	return nil, fmt.Errorf("failed to fetch models from known endpoints")
}

// LoadModel requests LM Studio to load a specific model
func (a *App) LoadModel(apiURL string, apiKey string, modelID string) error {
	endpoint := strings.TrimSuffix(apiURL, "/")
	endpoint = strings.TrimSuffix(endpoint, "/v1")
	loadURL := endpoint + "/v1/models/load"

	log.Printf("[App] Requesting load for model: %s to %s", modelID, loadURL)

	payload := map[string]interface{}{
		"model": modelID,
	}
	body, _ := json.Marshal(payload)

	client := &http.Client{Timeout: 60 * time.Second} // Loading can take time
	req, err := http.NewRequest("POST", loadURL, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %v", err)
	}

	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connection failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("server returned HTTP %d: %s", resp.StatusCode, string(bodyBytes))
	}

	log.Printf("[App] Successfully loaded model: %s", modelID)
	return nil
}

// Greet returns a greeting for the given name
func (a *App) Greet(name string) string {
	return fmt.Sprintf("Hello %s, It's show time!", name)
}
