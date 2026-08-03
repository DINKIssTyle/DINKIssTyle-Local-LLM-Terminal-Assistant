//go:build !darwin

package app

import (
	"context"
	"errors"
)

type unavailableAppleIntelligenceClient struct{}

func newAppleIntelligenceClient() appleIntelligenceClient {
	return &unavailableAppleIntelligenceClient{}
}

func (c *unavailableAppleIntelligenceClient) Generate(context.Context, string, string) (string, error) {
	return "", errors.New("Apple Intelligence is only available on supported macOS devices")
}

func (c *unavailableAppleIntelligenceClient) Status() AppleIntelligenceStatus {
	return AppleIntelligenceStatus{
		State:  AppleIntelligenceStateOSUnsupported,
		Detail: "Apple Intelligence is only available on supported macOS devices.",
	}
}
