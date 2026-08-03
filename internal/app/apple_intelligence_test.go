package app

import (
	"strings"
	"testing"
)

func TestBuildAppleIntelligencePromptSeparatesInstructionsAndConversation(t *testing.T) {
	instructions, prompt := buildAppleIntelligencePrompt([]interface{}{
		map[string]interface{}{"role": "system", "content": "Use app tools when needed."},
		map[string]interface{}{"role": "user", "content": "Inspect this Mac."},
		map[string]interface{}{"role": "assistant", "content": "I will inspect it."},
		map[string]interface{}{"role": "tool", "content": "Apple M4"},
	})

	if instructions != "Use app tools when needed." {
		t.Fatalf("unexpected instructions: %q", instructions)
	}
	for _, expected := range []string{"User:\nInspect this Mac.", "Assistant:\nI will inspect it.", "Tool:\nApple M4"} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("prompt does not contain %q: %q", expected, prompt)
		}
	}
}

func TestNormalizeAppleIntelligenceStateRejectsUnknownValues(t *testing.T) {
	if got := normalizeAppleIntelligenceState("future_state"); got != AppleIntelligenceStateUnavailable {
		t.Fatalf("unexpected normalized state: %q", got)
	}
}
