/*
    Created by DINKIssTyle on 2026.
    Copyright (C) 2026 DINKI'ssTyle. All rights reserved.
*/

package mcp

import (
	"encoding/json"
	"fmt"
	"log"
)

// TerminalExecutor is a callback function that writes to the terminal.
// It should return the output and any error.
var TerminalExecutor func(command string) (string, error)
var TerminalKeyExecutor func(keys []string) (string, error)

type Tool struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema interface{} `json:"inputSchema"`
}

func GetToolList() []Tool {
	return []Tool{
		{
			Name:        "search_web",
			Description: "Search the internet using DuckDuckGo. Use this to find current information.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string", "description": "Search query"},
				},
				"required": []string{"query"},
			},
		},
		{
			Name:        "read_web_page",
			Description: "Read the text content of a specific URL. Use this ONLY when the user provides a URL or explicitly asks to read a specific page.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"url": map[string]interface{}{"type": "string", "description": "URL to visit"},
				},
				"required": []string{"url"},
			},
		},
		{
			Name:        "get_current_time",
			Description: "Get the current local date and time.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			Name:        "execute_command",
			Description: "Execute a shell command on the host. Use this to run system commands.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"command": map[string]interface{}{
						"type":        "string",
						"description": "The shell command to execute.",
					},
				},
				"required": []string{"command"},
			},
		},
		{
			Name:        "send_keys",
			Description: "Send raw key presses to the active terminal. Use this for ESC, ENTER, CTRL_C and editor interactions.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"keys": map[string]interface{}{
						"type":        "array",
						"description": "Ordered list of keys like ESC, ENTER, CTRL_C, or plain text chunks such as :q!",
						"items": map[string]interface{}{
							"type": "string",
						},
					},
				},
				"required": []string{"keys"},
			},
		},
		{
			Name:        "naver_search",
			Description: "Search Naver (Korean portal). Specialized for dictionary, Korea-related content, weather, and news.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string", "description": "The search query for Naver"},
				},
				"required": []string{"query"},
			},
		},
		{
			Name:        "namu_wiki",
			Description: "Search and read definitions from Namuwiki (Korean Wiki). Use this for Korean pop culture, history, or slang definitions.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"keyword": map[string]interface{}{"type": "string", "description": "The exact keyword to search on Namuwiki"},
				},
				"required": []string{"keyword"},
			},
		},
	}
}

func ExecuteToolByName(toolName string, argumentsJSON string) (string, error) {
	log.Printf("[MCP] ExecuteToolByName: %s", toolName)

	switch toolName {
	case "search_web":
		var args struct {
			Query string `json:"query"`
		}
		if err := json.Unmarshal([]byte(argumentsJSON), &args); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		return SearchWeb(args.Query)

	case "read_web_page":
		var args struct {
			URL string `json:"url"`
		}
		if err := json.Unmarshal([]byte(argumentsJSON), &args); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		return ReadPage(args.URL)

	case "get_current_time":
		return GetCurrentTime()

	case "execute_command":
		var args struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal([]byte(argumentsJSON), &args); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		if TerminalExecutor != nil {
			return TerminalExecutor(args.Command)
		}
		return ExecuteCommand(args.Command)

	case "send_keys":
		var args struct {
			Keys []string `json:"keys"`
		}
		if err := json.Unmarshal([]byte(argumentsJSON), &args); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		if len(args.Keys) == 0 {
			return "", fmt.Errorf("keys cannot be empty")
		}
		if TerminalKeyExecutor == nil {
			return "", fmt.Errorf("terminal key executor not configured")
		}
		return TerminalKeyExecutor(args.Keys)

	case "naver_search":
		var args struct {
			Query string `json:"query"`
		}
		if err := json.Unmarshal([]byte(argumentsJSON), &args); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		return SearchNaver(args.Query)

	case "namu_wiki":
		var args struct {
			Keyword string `json:"keyword"`
		}
		if err := json.Unmarshal([]byte(argumentsJSON), &args); err != nil {
			return "", fmt.Errorf("invalid arguments: %v", err)
		}
		return SearchNamuwiki(args.Keyword)

	default:
		return "", fmt.Errorf("tool not found: %s", toolName)
	}
}
