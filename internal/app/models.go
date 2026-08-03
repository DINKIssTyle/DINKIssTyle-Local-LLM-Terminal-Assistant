package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const maxModelsResponseBytes = 8 * 1024 * 1024

// ModelInfo is normalized model metadata for the settings model picker.
type ModelInfo struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Loaded      bool   `json:"loaded"`
	InstanceID  string `json:"instanceId,omitempty"`
}

type rawModelList struct {
	Data   []rawModel `json:"data"`
	Models []rawModel `json:"models"`
}

type rawModel struct {
	ID              string            `json:"id"`
	Key             string            `json:"key"`
	Name            string            `json:"name"`
	DisplayName     string            `json:"display_name"`
	DisplayNameAlt  string            `json:"displayName"`
	Loaded          bool              `json:"loaded"`
	IsLoaded        bool              `json:"is_loaded"`
	IsLoadedAlt     bool              `json:"isLoaded"`
	Active          bool              `json:"active"`
	CurrentlyLoaded bool              `json:"currently_loaded"`
	State           string            `json:"state"`
	Status          string            `json:"status"`
	LoadState       string            `json:"load_state"`
	LoadedInstances []json.RawMessage `json:"loaded_instances"`
}

func modelAPIBase(endpoint string) string {
	endpoint = normalizeAPIBaseURL(endpoint)
	if endpoint == "" {
		endpoint = "http://localhost:1234"
	}
	for _, suffix := range []string{
		"/api/v1/models/unload", "/api/v1/models/load", "/api/v1/models", "/api/v1/chat", "/api/v1",
		"/v1/models/unload", "/v1/models/load", "/v1/models", "/v1/chat/completions", "/chat/completions", "/v1",
	} {
		if strings.HasSuffix(endpoint, suffix) {
			return strings.TrimSuffix(endpoint, suffix)
		}
	}
	return endpoint
}

func modelListEndpoints(provider, endpoint string) []string {
	base := modelAPIBase(endpoint)
	if strings.EqualFold(strings.TrimSpace(provider), "LM Studio") {
		return []string{base + "/api/v1/models", base + "/v1/models"}
	}
	return []string{base + "/v1/models"}
}

func setModelAPIHeaders(req *http.Request, provider, apiKey string) {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	} else if strings.EqualFold(strings.TrimSpace(provider), "LM Studio") {
		req.Header.Set("Authorization", "Bearer lm-studio")
	}
}

// FetchAvailableModels supports both LM Studio's native API and OpenAI-compatible model lists.
func (a *App) FetchAvailableModels(provider, apiURL, apiKey string) ([]ModelInfo, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	var lastErr error
	for _, modelsURL := range modelListEndpoints(provider, apiURL) {
		logVerbosef("[App] Fetching models from: %s", modelsURL)
		req, err := http.NewRequest(http.MethodGet, modelsURL, nil)
		if err != nil {
			lastErr = err
			continue
		}
		setModelAPIHeaders(req, provider, apiKey)
		resp, err := client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("connection failed for %s: %w", modelsURL, err)
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxModelsResponseBytes+1))
		resp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if len(body) > maxModelsResponseBytes {
			lastErr = errors.New("model list response is too large")
			continue
		}
		if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
			lastErr = fmt.Errorf("model server returned HTTP %d from %s: %s", resp.StatusCode, modelsURL, strings.TrimSpace(string(body)))
			continue
		}
		models, parseErr := parseModelList(body)
		if parseErr != nil {
			lastErr = fmt.Errorf("failed to parse models from %s: %w", modelsURL, parseErr)
			continue
		}
		logVerbosef("[App] Successfully fetched %d models from %s", len(models), modelsURL)
		return models, nil
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, errors.New("failed to fetch models from known endpoints")
}

// UnloadModel unloads one concrete LM Studio model instance.
func (a *App) UnloadModel(provider, apiURL, apiKey, instanceID string) error {
	instanceID = strings.TrimSpace(instanceID)
	if instanceID == "" {
		return errors.New("model instance ID is required")
	}
	payload, err := json.Marshal(map[string]string{"instance_id": instanceID})
	if err != nil {
		return err
	}
	unloadURL := modelAPIBase(apiURL) + "/api/v1/models/unload"
	req, err := http.NewRequest(http.MethodPost, unloadURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	setModelAPIHeaders(req, provider, apiKey)
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("unload model: %w", err)
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxModelsResponseBytes+1))
	if readErr != nil {
		return readErr
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("model server returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

func parseModelList(body []byte) ([]ModelInfo, error) {
	var list rawModelList
	if err := json.Unmarshal(body, &list); err != nil {
		var direct []rawModel
		if directErr := json.Unmarshal(body, &direct); directErr != nil {
			return nil, err
		}
		list.Data = direct
	}
	models := list.Data
	if len(models) == 0 {
		models = list.Models
	}
	result := make([]ModelInfo, 0, len(models))
	seen := make(map[string]bool, len(models))
	for _, model := range models {
		id := firstNonEmpty(model.ID, model.Key, model.Name)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		displayName := firstNonEmpty(model.DisplayName, model.DisplayNameAlt, model.Name, id)
		instanceID := firstLoadedInstanceID(model.LoadedInstances)
		state := strings.ToLower(firstNonEmpty(model.State, model.Status, model.LoadState))
		loaded := instanceID != "" || model.Loaded || model.IsLoaded || model.IsLoadedAlt || model.Active ||
			model.CurrentlyLoaded || state == "loaded" || state == "active" || state == "ready" || state == "resident"
		result = append(result, ModelInfo{ID: id, DisplayName: displayName, Loaded: loaded, InstanceID: instanceID})
	}
	return result, nil
}

func firstLoadedInstanceID(instances []json.RawMessage) string {
	for _, raw := range instances {
		var stringID string
		if json.Unmarshal(raw, &stringID) == nil && strings.TrimSpace(stringID) != "" {
			return strings.TrimSpace(stringID)
		}
		var instance struct {
			InstanceID string `json:"instance_id"`
			ID         string `json:"id"`
			Key        string `json:"key"`
		}
		if json.Unmarshal(raw, &instance) == nil {
			if id := firstNonEmpty(instance.InstanceID, instance.ID, instance.Key); id != "" {
				return id
			}
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
