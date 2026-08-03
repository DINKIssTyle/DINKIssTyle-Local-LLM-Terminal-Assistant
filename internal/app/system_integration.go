package app

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
)

var linuxIntegrationIconPNG []byte

func SetLinuxIntegrationIcon(icon []byte) {
	linuxIntegrationIconPNG = append([]byte(nil), icon...)
}

func (a *App) InstallSystemIntegration() (string, error) {
	if goruntime.GOOS != "linux" {
		return "", errors.New("system integration is only available on Linux")
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, resolveErr := filepath.EvalSymlinks(executable); resolveErr == nil {
		executable = resolved
	}

	binPath := filepath.Join(home, ".local", "bin", "dkst-terminal-ai")
	desktopPath := filepath.Join(home, ".local", "share", "applications", "dkst-terminal-ai.desktop")
	iconPath := filepath.Join(home, ".local", "share", "icons", "hicolor", "512x512", "apps", "dkst-terminal-ai.png")
	pixmapPath := filepath.Join(home, ".local", "share", "pixmaps", "dkst-terminal-ai.png")

	if err := copyExecutableIfNeeded(executable, binPath); err != nil {
		return "", err
	}
	if len(linuxIntegrationIconPNG) == 0 {
		return "", errors.New("application icon is unavailable")
	}
	for _, path := range []string{iconPath, pixmapPath} {
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			return "", err
		}
		if err := os.WriteFile(path, linuxIntegrationIconPNG, 0644); err != nil {
			return "", err
		}
	}

	if err := os.MkdirAll(filepath.Dir(desktopPath), 0755); err != nil {
		return "", err
	}
	desktopEntry := fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=DKST Terminal AI
Comment=Local LLM terminal assistant
Exec=%s
Icon=dkst-terminal-ai
Terminal=false
Categories=Utility;Development;System;
StartupNotify=true
StartupWMClass=DKST Terminal AI
`, quoteDesktopExec(binPath))
	if err := os.WriteFile(desktopPath, []byte(desktopEntry), 0644); err != nil {
		return "", err
	}

	refreshLinuxDesktop(home)
	return "installed", nil
}

func (a *App) UninstallSystemIntegration() (string, error) {
	if goruntime.GOOS != "linux" {
		return "", errors.New("system integration is only available on Linux")
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	targets := []string{
		filepath.Join(home, ".local", "bin", "dkst-terminal-ai"),
		filepath.Join(home, ".local", "share", "applications", "dkst-terminal-ai.desktop"),
		filepath.Join(home, ".local", "share", "icons", "hicolor", "512x512", "apps", "dkst-terminal-ai.png"),
		filepath.Join(home, ".local", "share", "pixmaps", "dkst-terminal-ai.png"),
	}
	for _, target := range targets {
		if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}

	refreshLinuxDesktop(home)
	return "uninstalled", nil
}

func copyExecutableIfNeeded(source string, target string) error {
	if sourceInfo, err := os.Stat(source); err == nil {
		if targetInfo, targetErr := os.Stat(target); targetErr == nil && os.SameFile(sourceInfo, targetInfo) {
			return os.Chmod(target, 0755)
		}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}

	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()

	temporary, err := os.CreateTemp(filepath.Dir(target), ".dkst-terminal-ai-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)

	if _, err := io.Copy(temporary, input); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Chmod(0755); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, target)
}

func quoteDesktopExec(path string) string {
	return `"` + strings.ReplaceAll(path, `"`, `\"`) + `"`
}

func refreshLinuxDesktop(home string) {
	commands := [][]string{
		{"update-desktop-database", filepath.Join(home, ".local", "share", "applications")},
		{"gtk-update-icon-cache", "-f", "-t", filepath.Join(home, ".local", "share", "icons", "hicolor")},
	}
	for _, args := range commands {
		if executable, err := exec.LookPath(args[0]); err == nil {
			_ = exec.Command(executable, args[1:]...).Run()
		}
	}
}
