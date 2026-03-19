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
