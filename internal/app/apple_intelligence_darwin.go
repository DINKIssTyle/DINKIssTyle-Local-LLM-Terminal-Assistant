//go:build darwin

package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const appleIntelligenceHelperName = "DKSTAppleIntelligenceHelper"

type appleIntelligenceProcessClient struct{}

type appleIntelligenceHelperRequest struct {
	Mode         string `json:"mode"`
	Instructions string `json:"instructions,omitempty"`
	Prompt       string `json:"prompt,omitempty"`
}

type appleIntelligenceHelperResponse struct {
	Available bool   `json:"available"`
	State     string `json:"state"`
	Content   string `json:"content,omitempty"`
	Error     string `json:"error,omitempty"`
}

func newAppleIntelligenceClient() appleIntelligenceClient {
	return &appleIntelligenceProcessClient{}
}

func (c *appleIntelligenceProcessClient) Generate(ctx context.Context, instructions string, prompt string) (string, error) {
	response, err := invokeAppleIntelligenceHelper(ctx, appleIntelligenceHelperRequest{
		Mode:         "generate",
		Instructions: instructions,
		Prompt:       prompt,
	})
	if err != nil {
		return "", err
	}
	if !response.Available {
		return "", appleIntelligenceAvailabilityError(response)
	}
	if detail := strings.TrimSpace(response.Error); detail != "" {
		return "", errors.New(detail)
	}
	content := strings.TrimSpace(response.Content)
	if content == "" {
		return "", errors.New("Apple Intelligence returned an empty response")
	}
	return content, nil
}

func (c *appleIntelligenceProcessClient) Status() AppleIntelligenceStatus {
	response, err := invokeAppleIntelligenceHelper(context.Background(), appleIntelligenceHelperRequest{Mode: "availability"})
	if err != nil {
		state := AppleIntelligenceStateUnavailable
		if errors.Is(err, os.ErrNotExist) {
			state = AppleIntelligenceStateHelperUnavailable
		}
		return AppleIntelligenceStatus{State: state, Detail: err.Error()}
	}
	return AppleIntelligenceStatus{
		Available: response.Available,
		State:     normalizeAppleIntelligenceState(response.State),
		Detail:    strings.TrimSpace(response.Error),
	}
}

func invokeAppleIntelligenceHelper(ctx context.Context, request appleIntelligenceHelperRequest) (appleIntelligenceHelperResponse, error) {
	helperPath, err := findAppleIntelligenceHelper()
	if err != nil {
		return appleIntelligenceHelperResponse{}, err
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return appleIntelligenceHelperResponse{}, err
	}

	cmd := exec.CommandContext(ctx, helperPath)
	cmd.Stdin = bytes.NewReader(payload)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return appleIntelligenceHelperResponse{}, context.Canceled
		}
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return appleIntelligenceHelperResponse{}, fmt.Errorf("Apple Intelligence helper failed: %s", detail)
	}

	var response appleIntelligenceHelperResponse
	if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
		return appleIntelligenceHelperResponse{}, fmt.Errorf("invalid Apple Intelligence helper response: %w", err)
	}
	response.State = normalizeAppleIntelligenceState(response.State)
	return response, nil
}

func findAppleIntelligenceHelper() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("DKST_APPLE_INTELLIGENCE_HELPER")); configured != "" {
		if info, err := os.Stat(configured); err == nil && !info.IsDir() {
			return configured, nil
		}
		return "", fmt.Errorf("%w: Apple Intelligence helper at %s", os.ErrNotExist, configured)
	}

	var candidates []string
	if executable, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(executable), appleIntelligenceHelperName))
	}
	if workingDirectory, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(workingDirectory, "build", "bin", appleIntelligenceHelperName),
			filepath.Join(workingDirectory, "bin", appleIntelligenceHelperName),
			filepath.Join(workingDirectory, appleIntelligenceHelperName),
		)
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%w: %s is not bundled with the app", os.ErrNotExist, appleIntelligenceHelperName)
}

func appleIntelligenceAvailabilityError(response appleIntelligenceHelperResponse) error {
	detail := strings.TrimSpace(response.Error)
	if detail == "" {
		detail = "Apple Intelligence is unavailable"
	}
	return fmt.Errorf("%s (%s)", detail, normalizeAppleIntelligenceState(response.State))
}
