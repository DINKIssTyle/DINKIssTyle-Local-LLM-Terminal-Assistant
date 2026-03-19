/*
    Created by DINKIssTyle on 2026.
    Copyright (C) 2026 DINKI'ssTyle. All rights reserved.
*/

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
	"dkst-terminal-assistant/mcp"
)

type mcpJSONRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	ID      interface{}     `json:"id"`
}

type mcpJSONRPCResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	Result  interface{} `json:"result,omitempty"`
	Error   interface{} `json:"error,omitempty"`
	ID      interface{} `json:"id"`
}

type MCPServer struct {
	app      *App
	listener net.Listener
	mu       sync.Mutex
	clients  map[chan string]bool
}

func NewMCPServer(app *App) *MCPServer {
	return &MCPServer{
		app:     app,
		clients: make(map[chan string]bool),
	}
}

func (s *MCPServer) addClient(ch chan string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clients[ch] = true
}

func (s *MCPServer) removeClient(ch chan string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.clients, ch)
	close(ch)
}

func (s *MCPServer) broadcast(payload string) int {
	s.mu.Lock()
	defer s.mu.Unlock()

	count := 0
	for ch := range s.clients {
		select {
		case ch <- payload:
			count++
		default:
			log.Printf("[MCP Server] Broadcast skipped for a slow client")
		}
	}
	return count
}

func (s *MCPServer) Start(port int) {
	mux := http.NewServeMux()
	
	mux.HandleFunc("/mcp/sse", s.handleSSE)
	mux.HandleFunc("/mcp/messages", s.handleMessage)
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
		log.Printf("[MCP Server] Listening on port %d", port)
		if err := http.Serve(ln, mux); err != nil {
			log.Printf("[MCP Server] HTTP Serve error: %v", err)
		}
	}()
}

func (s *MCPServer) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener != nil {
		s.listener.Close()
		s.listener = nil
	}
}

func (s *MCPServer) buildResponse(req *mcpJSONRPCRequest) *mcpJSONRPCResponse {
	resp := &mcpJSONRPCResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
	}

	switch req.Method {
	case "initialize":
		resp.Result = map[string]interface{}{
			"protocolVersion": "2024-11-05",
			"capabilities": map[string]interface{}{
				"tools": map[string]interface{}{"listChanged": false},
			},
			"serverInfo": map[string]string{
				"name":    "dkst-terminal-assistant",
				"version": "1.0.0",
			},
		}
	case "notifications/initialized":
		return nil
	case "ping":
		resp.Result = map[string]interface{}{}
	case "tools/list":
		resp.Result = map[string]interface{}{
			"tools": mcp.GetToolList(),
		}
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			resp.Error = map[string]interface{}{"code": -32602, "message": "invalid params"}
			return resp
		}

		res, callErr := mcp.ExecuteToolByName(params.Name, string(params.Arguments))
		if callErr != nil {
			resp.Error = map[string]interface{}{"code": -32603, "message": callErr.Error()}
		} else {
			resp.Result = map[string]interface{}{
				"content": []map[string]interface{}{
					{"type": "text", "text": res},
				},
			}
		}
	default:
		resp.Error = map[string]interface{}{"code": -32601, "message": fmt.Sprintf("method not found: %s", req.Method)}
	}

	return resp
}

func (s *MCPServer) handleSSE(w http.ResponseWriter, r *http.Request) {
	log.Printf("[MCP-DEBUG] HandleSSE (SSE Open) from %s Method=%s", r.RemoteAddr, r.Method)

	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	var initialReq *mcpJSONRPCRequest
	if r.Method == http.MethodPost {
		bodyBytes, err := io.ReadAll(r.Body)
		if err == nil && len(bodyBytes) > 0 {
			var req mcpJSONRPCRequest
			if err := json.Unmarshal(bodyBytes, &req); err == nil {
				initialReq = &req
				log.Printf("[MCP Server] Captured Initial POST: %s", req.Method)
			}
		}
		r.Body.Close()
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}

	messageChan := make(chan string, 200)
	s.addClient(messageChan)
	defer s.removeClient(messageChan)

	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	endpointURL := fmt.Sprintf("%s://%s/mcp/messages", scheme, r.Host)
	if r.Host == "" {
		endpointURL = fmt.Sprintf("http://localhost:%d/mcp/messages", s.app.mcpPort)
	}

	fmt.Fprintf(w, "event: endpoint\ndata: %s\n\n", endpointURL)
	flusher.Flush()
	log.Printf("[MCP-DEBUG] Advertised Endpoint: %s", endpointURL)

	if initialReq != nil {
		res := s.buildResponse(initialReq)
		if res != nil {
			respBytes, _ := json.Marshal(res)
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", string(respBytes))
			flusher.Flush()
			log.Printf("[MCP-DEBUG] Inline Response sent for %s", initialReq.Method)

			if initialReq.Method != "initialize" {
				log.Printf("[MCP-DEBUG] Short-circuiting POST request for %s", initialReq.Method)
				return
			}
		}
	}

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case msg := <-messageChan:
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", msg)
			flusher.Flush()
		case <-ticker.C:
			fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			log.Printf("[MCP Server] SSE Client Disconnected: %s", r.RemoteAddr)
			return
		}
	}
}

func (s *MCPServer) handleMessage(w http.ResponseWriter, r *http.Request) {
	log.Printf("[MCP-DEBUG] HandleMessages (POST) from %s", r.RemoteAddr)

	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	r.Body.Close()

	var req mcpJSONRPCRequest
	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	log.Printf("[MCP Server] Received Request: %s (ID: %v)", req.Method, req.ID)

	w.WriteHeader(http.StatusAccepted)

	go func() {
		time.Sleep(50 * time.Millisecond)
		res := s.buildResponse(&req)
		if res != nil {
			respBytes, _ := json.Marshal(res)
			count := s.broadcast(string(respBytes))
			log.Printf("[MCP Server] Broadcasted %s to %d clients", req.Method, count)
		}
	}()
}

func (s *MCPServer) handleTools(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(mcp.GetToolList())
}
