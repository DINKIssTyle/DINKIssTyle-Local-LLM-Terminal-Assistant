package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

const (
	appleIntelligenceProvider = "Apple Intelligence"

	AppleIntelligenceStateAvailable         = "available"
	AppleIntelligenceStateDeviceNotEligible = "device_not_eligible"
	AppleIntelligenceStateNotEnabled        = "not_enabled"
	AppleIntelligenceStateModelNotReady     = "model_not_ready"
	AppleIntelligenceStateOSUnsupported     = "os_unsupported"
	AppleIntelligenceStateSDKUnavailable    = "sdk_unavailable"
	AppleIntelligenceStateHelperUnavailable = "helper_unavailable"
	AppleIntelligenceStateUnavailable       = "unavailable"
	AppleIntelligenceStateChecking          = "checking"
)

type AppleIntelligenceStatus struct {
	Available bool   `json:"available"`
	State     string `json:"state"`
	Detail    string `json:"detail,omitempty"`
}

type appleIntelligenceClient interface {
	Generate(ctx context.Context, instructions string, prompt string) (string, error)
	Status() AppleIntelligenceStatus
}

func (a *App) GetAppleIntelligenceStatus() AppleIntelligenceStatus {
	if a.appleIntelligence == nil {
		return AppleIntelligenceStatus{
			State:  AppleIntelligenceStateUnavailable,
			Detail: "Apple Intelligence client is unavailable.",
		}
	}
	return a.appleIntelligence.Status()
}

func buildAppleIntelligencePrompt(messages []interface{}) (string, string) {
	var instructions []string
	var conversation []string

	for _, rawMessage := range messages {
		message, ok := rawMessage.(map[string]interface{})
		if !ok {
			continue
		}

		role := strings.ToLower(strings.TrimSpace(fmt.Sprint(message["role"])))
		content := appleIntelligenceMessageContent(message["content"])
		if content == "" {
			continue
		}

		if role == "system" {
			instructions = append(instructions, content)
			continue
		}

		label := "User"
		switch role {
		case "assistant":
			label = "Assistant"
		case "tool":
			label = "Tool"
		}
		conversation = append(conversation, label+":\n"+content)
	}

	if len(instructions) == 0 {
		instructions = append(instructions, "You are DKST Terminal AI, a careful terminal and coding assistant.")
	}
	return strings.Join(instructions, "\n\n"), strings.Join(conversation, "\n\n")
}

func appleIntelligenceMessageContent(content interface{}) string {
	if text, ok := content.(string); ok {
		return strings.TrimSpace(text)
	}
	if content == nil {
		return ""
	}
	encoded, err := json.Marshal(content)
	if err != nil {
		return strings.TrimSpace(fmt.Sprint(content))
	}
	return strings.TrimSpace(string(encoded))
}

func normalizeAppleIntelligenceState(state string) string {
	trimmed := strings.TrimSpace(state)
	switch trimmed {
	case AppleIntelligenceStateAvailable,
		AppleIntelligenceStateDeviceNotEligible,
		AppleIntelligenceStateNotEnabled,
		AppleIntelligenceStateModelNotReady,
		AppleIntelligenceStateOSUnsupported,
		AppleIntelligenceStateSDKUnavailable,
		AppleIntelligenceStateHelperUnavailable,
		AppleIntelligenceStateUnavailable,
		AppleIntelligenceStateChecking:
		return trimmed
	default:
		return AppleIntelligenceStateUnavailable
	}
}
