/*
    Created by DINKIssTyle on 2026.
    Copyright (C) 2026 DINKI'ssTyle. All rights reserved.
*/

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"dkst-terminal-assistant/mcp"
	"dkst-terminal-assistant/terminal"

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

	return int(digit[0]-'1'), true
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

// App struct
type App struct {
	ctx         context.Context
	terminals   map[string]*terminal.Terminal
	activeTabId string
	mcpPort     int
	mcpLabel    string
	mcpServer   *MCPServer
	mu          sync.Mutex
	cancelFunc  context.CancelFunc
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		terminals: make(map[string]*terminal.Terminal),
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

		// Write to terminal and wait a bit for output or just return success
		// Real interactive output is hard to capture synchronously, 
		// but since it's a real terminal, the user will see it.
		// We'll return a message that it's running in the terminal.
		err := a.WriteToTerminal(activeId, command+"\n")
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("Command '%s' sent to active terminal (Tab ID: %s)", command, activeId), nil
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
	return nil
}

// SetActiveTab sets the currently active terminal tab ID
func (a *App) SetActiveTab(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.activeTabId = id
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

	url := apiURL
	// Add protocol if missing
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		url = "http://" + url
	}

	// Handle provider specific paths
	if provider == "LM Studio" || provider == "Ollama" {
		if !strings.HasSuffix(url, "/v1") && !strings.HasSuffix(url, "/v1/") {
			url = strings.TrimSuffix(url, "/") + "/v1"
		}
	} else if provider == "OpenAI" {
		if !strings.HasSuffix(url, "/v1") && !strings.HasSuffix(url, "/v1/") {
			url = strings.TrimSuffix(url, "/") + "/v1"
		}
	}

	url = strings.TrimSuffix(url, "/") + "/chat/completions"

	payload := map[string]interface{}{
		"model":       modelName,
		"messages":    messages,
		"max_tokens":  maxTokens,
		"temperature": temperature,
		"stream":      isStreaming,
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
		log.Printf("[LLM] Starting SSE stream scanner...")
		for scanner.Scan() {
			line := scanner.Text()
			log.Printf("[LLM] RAW LINE: %s", line)

			if line == "" || !strings.HasPrefix(line, "data: ") {
				continue
			}

			data := strings.TrimPrefix(line, "data: ")
			if data == "[DONE]" {
				log.Printf("[LLM] Stream received [DONE]")
				break
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
		}
		if err := scanner.Err(); err != nil {
			log.Printf("[LLM] Scanner error: %v", err)
		}
		log.Printf("[LLM] Stream complete. Total length: %d", len(fullContent))
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

// Greet returns a greeting for the given name
func (a *App) Greet(name string) string {
	return fmt.Sprintf("Hello %s, It's show time!", name)
}
