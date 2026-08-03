# App-managed tool runtime

DKST Terminal AI owns tool discovery, execution, approval, timeouts, and result
delivery. LM Studio, OpenAI-compatible providers, and the macOS on-device Apple
Intelligence provider are inference backends only and do not need an MCP
registration for the app's tools.

## Request flow

1. The app reads the shared tool catalog from `internal/toolruntime`.
2. The app includes enabled tools in the common system prompt.
3. The selected model emits the common structured tool-call markup.
4. The app validates and executes the call through the shared runtime.
5. The app sends the observed tool result back to the selected model.
6. The model produces the final response.

Provider adapters may differ in endpoint, authentication, payload, and streaming
format. They must not own tool registration or execution.

The former LM Studio-facing SSE MCP gateway and its `mcp.json` setup are no
longer part of the application runtime.
