package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func TestLoadSkillsFromUserDirectory(t *testing.T) {
	root := t.TempDir()
	skillDirectory := filepath.Join(root, "custom-checks")
	if err := os.MkdirAll(skillDirectory, 0755); err != nil {
		t.Fatal(err)
	}
	content := "---\nname: custom-checks\ndescription: Check a custom project deployment.\n---\n\n# Custom Checks\n\nInspect deployment status."
	if err := os.WriteFile(filepath.Join(skillDirectory, "SKILL.md"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	documents := loadSkillsFromDirectory(root)
	document, ok := documents["custom-checks"]
	if !ok || document.Source != "user" || !strings.Contains(document.Body, "deployment status") {
		t.Fatalf("user skill was not loaded: %#v", documents)
	}
}

func TestSkillRegistrySelectsCurrentOSCommandSkill(t *testing.T) {
	skillFS := fstest.MapFS{
		"skills/macos-commands/SKILL.md": {
			Data: []byte("---\nname: macos-commands\ndescription: Native macOS terminal commands.\n---\n\n# macOS\n\nUse sysctl and sw_vers."),
		},
		"skills/linux-commands/SKILL.md": {
			Data: []byte("---\nname: linux-commands\ndescription: Native Linux terminal commands.\n---\n\n# Linux\n\nUse lscpu and systemctl."),
		},
	}
	registry := newSkillRegistry(skillFS)
	registry.lastUserRefresh = time.Now()

	context := registry.resolve("CPU와 메모리 상태를 확인해줘", "darwin", 6000)
	if !strings.Contains(context, "ACTIVE SKILL: macos-commands") || !strings.Contains(context, "sysctl") {
		t.Fatalf("unexpected skill context: %q", context)
	}
}

func TestUserSkillOverridesBuiltinSkillByName(t *testing.T) {
	registry := &skillRegistry{
		builtin: map[string]skillDocument{
			"macos-commands": {Name: "macos-commands", Description: "macOS commands", Body: "builtin body", Source: "builtin"},
		},
		user: map[string]skillDocument{
			"macos-commands": {Name: "macos-commands", Description: "macOS commands", Body: "user override body", Source: "user:test"},
		},
		lastUserRefresh: time.Now(),
	}

	context := registry.resolve("터미널 명령을 실행해줘", "darwin", 6000)
	if !strings.Contains(context, "user override body") || strings.Contains(context, "builtin body") {
		t.Fatalf("user override was not selected: %q", context)
	}
}

func TestExplicitSkillInvocationWinsSelection(t *testing.T) {
	documents := map[string]skillDocument{
		"macos-commands":  {Name: "macos-commands", Description: "macOS command tasks", Body: "mac"},
		"project-release": {Name: "project-release", Description: "Prepare project releases", Body: "release"},
	}

	selected, score := selectSkill(documents, "Use $project-release for this terminal task", "darwin")
	if selected.Name != "project-release" || score < 100 {
		t.Fatalf("explicit skill was not preferred: name=%q score=%d", selected.Name, score)
	}
}

func TestCrossPlatformSkillMatchesKoreanMetadata(t *testing.T) {
	documents := map[string]skillDocument{
		"macos-commands": {
			Name:        "macos-commands",
			Description: "Use native macOS terminal commands for files and paths.",
			Body:        "Use ls.",
		},
		"github-management": {
			Name:        "github-management",
			Description: "Manage GitHub repositories, 깃허브, 깃헙, 저장소 관리, 이슈, PR, and releases.",
			Body:        "Use gh issue list.",
		},
	}

	selected, score := selectSkill(documents, "깃헙 저장소의 이슈 파일을 보여줘", "darwin")
	if selected.Name != "github-management" || score < 4 {
		t.Fatalf("cross-platform skill did not match Korean metadata: name=%q score=%d", selected.Name, score)
	}
}

func TestCrossPlatformSkillMatchesSingleDistinctiveOperation(t *testing.T) {
	documents := map[string]skillDocument{
		"github-management": {
			Name:        "github-management",
			Description: "Manage Git repositories including force push, merge, rebase, reset, 강제 푸시, 병합, 리베이스, and 리셋.",
			Body:        "Inspect before rewriting history.",
		},
	}

	for _, request := range []string{"리베이스 해줘", "rebase the commits"} {
		selected, score := selectSkill(documents, request, "linux")
		if selected.Name != "github-management" || score < 4 {
			t.Fatalf("Git history operation did not select the skill for %q: name=%q score=%d", request, selected.Name, score)
		}
	}
}

func TestSkillContextLimitUsesRunes(t *testing.T) {
	value := strings.Repeat("가", 1100)
	clamped := clampSkillContext(value, 1000)
	if !strings.HasSuffix(clamped, "... (skill content truncated)") {
		t.Fatalf("expected truncation marker: %q", clamped[len(clamped)-40:])
	}
}
