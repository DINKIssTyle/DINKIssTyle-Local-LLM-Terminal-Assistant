package app

import (
	"encoding/json"
	"testing"
)

func TestMCPInitializeCompatibility(t *testing.T) {
	server := &MCPServer{}
	response := server.buildResponse(&mcpJSONRPCRequest{JSONRPC: "2.0", ID: 1, Method: "initialize"})
	result, ok := response.Result.(map[string]interface{})
	if !ok {
		t.Fatalf("initialize result has unexpected type: %T", response.Result)
	}
	if result["protocolVersion"] != "2024-11-05" {
		t.Fatalf("unexpected protocol version: %v", result["protocolVersion"])
	}
}

func TestMCPToolFailureUsesMCPResultShape(t *testing.T) {
	server := &MCPServer{}
	params, err := json.Marshal(map[string]interface{}{
		"name":      "tool_that_does_not_exist",
		"arguments": map[string]interface{}{},
	})
	if err != nil {
		t.Fatal(err)
	}

	response := server.buildResponse(&mcpJSONRPCRequest{
		JSONRPC: "2.0",
		ID:      2,
		Method:  "tools/call",
		Params:  params,
	})
	if response.Error != nil {
		t.Fatalf("tool execution errors must be returned as an MCP result, got JSON-RPC error: %v", response.Error)
	}
	result, ok := response.Result.(map[string]interface{})
	if !ok {
		t.Fatalf("tool error result has unexpected type: %T", response.Result)
	}
	if result["isError"] != true {
		t.Fatalf("tool error result missing isError=true: %#v", result)
	}
}
