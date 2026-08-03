// Package toolruntime provides the provider-independent tool boundary used by
// the application. Model providers only generate text; this runtime owns tool
// discovery and execution.
package toolruntime

import (
	"encoding/json"

	"dkst-terminal-assistant/internal/mcp"
)

// Tool is the common descriptor exposed to every model provider. Keeping this
// type at the app boundary prevents provider or transport details from leaking
// into the frontend contract.
type Tool struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema interface{} `json:"inputSchema"`
}

// HostFuncs connects app-owned terminal capabilities to the tool runtime.
type HostFuncs = mcp.ToolHostFuncs

// Initialize installs the app host and resets the runtime to its default local
// context. It does not start or register an MCP server with an LLM provider.
func Initialize(host HostFuncs) {
	mcp.SetHost(host)
	mcp.SetContext("default", false, nil, "", nil, nil)
}

// SetVerboseLoggingEnabled updates diagnostics for the shared tool runtime.
func SetVerboseLoggingEnabled(enabled bool) {
	mcp.SetVerboseLoggingEnabled(enabled)
}

// List returns the same tool catalog for LM Studio, OpenAI, Ollama, and custom
// providers.
func List() []Tool {
	registered := mcp.GetToolList()
	tools := make([]Tool, 0, len(registered))
	for _, tool := range registered {
		tools = append(tools, Tool{
			Name:        tool.Name,
			Description: tool.Description,
			InputSchema: tool.InputSchema,
		})
	}
	return tools
}

// Call executes a tool inside the application process.
func Call(name string, arguments json.RawMessage) (string, error) {
	return mcp.ExecuteToolByName(name, arguments, "default", false, nil)
}
