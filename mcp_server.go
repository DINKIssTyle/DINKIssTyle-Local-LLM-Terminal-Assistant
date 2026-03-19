/*
    Created by DINKIssTyle on 2026.
    Copyright (C) 2026 DINKI'ssTyle. All rights reserved.
*/

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"dkst-terminal-assistant/mcp"
)

type MCPServer struct {
	app      *App
	listener net.Listener
	mu       sync.Mutex
}

func NewMCPServer(app *App) *MCPServer {
	return &MCPServer{app: app}
}

func (s *MCPServer) Start(port int) {
	mux := http.NewServeMux()
	
	// Basic MCP SSE implementation (Minimal)
	mux.HandleFunc("/sse", s.handleSSE)
	mux.HandleFunc("/mcp/sse", s.handleSSE)
	mux.HandleFunc("/message", s.handleMessage)
	mux.HandleFunc("/mcp/message", s.handleMessage)
    
    // Tool list for convenience
    mux.HandleFunc("/tools", s.handleTools)

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		log.Printf("[MCP Server] Listen Error: %v", err)
		return
	}

	s.mu.Lock()
	s.listener = ln
	s.mu.Unlock()

	go func() {
		log.Printf("[MCP Server] Starting on port %d", port)
		if err := http.Serve(ln, mux); err != nil {
			// Expected error when listener is closed
			log.Printf("[MCP Server] stopped or error: %v", err)
		}
	}()
}

func (s *MCPServer) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener != nil {
		log.Printf("[MCP Server] Stopping server...")
		s.listener.Close()
		s.listener = nil
	}
}

func (s *MCPServer) handleSSE(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	// Send initial connection event
	fmt.Fprintf(w, "event: endpoint\ndata: /message\n\n")
	w.(http.Flusher).Flush()

	// Keep connection open
	<-r.Context().Done()
}

func (s *MCPServer) handleMessage(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }

	var req struct {
		JSONRPC string          `json:"jsonrpc"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
		ID      interface{}     `json:"id"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var result interface{}
	var err error

	switch req.Method {
	case "tools/list":
		result = map[string]interface{}{
			"tools": mcp.GetToolList(),
		}
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		json.Unmarshal(req.Params, &params)
		
		res, callErr := mcp.ExecuteToolByName(params.Name, string(params.Arguments))
		if callErr != nil {
			err = callErr
		} else {
			result = map[string]interface{}{
				"content": []map[string]interface{}{
					{"type": "text", "text": res},
				},
			}
		}
	default:
		err = fmt.Errorf("method not found: %s", req.Method)
	}

	resp := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      req.ID,
	}
	if err != nil {
		resp["error"] = map[string]interface{}{"code": -32603, "message": err.Error()}
	} else {
		resp["result"] = result
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *MCPServer) handleTools(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(mcp.GetToolList())
}
