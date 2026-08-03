package toolruntime

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestListExposesSharedToolCatalog(t *testing.T) {
	tools := List()
	for _, tool := range tools {
		if tool.Name == "get_current_time" {
			return
		}
	}

	t.Fatal("shared tool catalog does not include get_current_time")
}

func TestCallExecutesInsideAppRuntime(t *testing.T) {
	result, err := Call("get_current_time", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("app-managed tool call failed: %v", err)
	}
	if strings.TrimSpace(result) == "" {
		t.Fatal("app-managed tool call returned an empty result")
	}
}

func TestCallRejectsUnknownTool(t *testing.T) {
	_, err := Call("tool_that_does_not_exist", json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("unknown tool call unexpectedly succeeded")
	}
}
