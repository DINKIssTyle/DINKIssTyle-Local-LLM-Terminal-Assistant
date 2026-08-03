package main

import (
	"runtime"
	"strings"
	"testing"

	"dkst-terminal-assistant/internal/app"
)

func TestEmbeddedSkillsAreAvailableToApp(t *testing.T) {
	app.SetBuiltinSkills(builtinSkills)
	application := app.NewApp()

	expectedSkill := map[string]string{
		"darwin":  "macos-commands",
		"linux":   "linux-commands",
		"windows": "windows-powershell-commands",
	}[runtime.GOOS]
	if expectedSkill == "" {
		t.Skip("no bundled operating-system skill for this platform")
	}

	context := application.ResolveSkillContext("CPU와 메모리 상태를 터미널에서 확인해줘", 6000)
	if !strings.Contains(context, "ACTIVE SKILL: "+expectedSkill) {
		t.Fatalf("embedded operating-system skill was not selected: %q", context)
	}
	if !strings.Contains(context, "## Non-negotiable execution contract") ||
		!strings.Contains(context, "Never prefix a command with `powershell`") {
		t.Fatalf("embedded skill content was not loaded: %q", context)
	}
}

func TestEmbeddedCrossPlatformSkillIsAvailable(t *testing.T) {
	app.SetBuiltinSkills(builtinSkills)
	application := app.NewApp()

	context := application.ResolveSkillContext("깃헙 이슈를 확인해줘", 6000)
	if !strings.Contains(context, "ACTIVE SKILL: github-management") {
		t.Fatalf("embedded cross-platform skill was not selected: %q", context)
	}
	if !strings.Contains(context, "git push --force-with-lease origin main") || !strings.Contains(context, "gh issue list") {
		t.Fatalf("embedded GitHub skill content was not loaded: %q", context)
	}
}
