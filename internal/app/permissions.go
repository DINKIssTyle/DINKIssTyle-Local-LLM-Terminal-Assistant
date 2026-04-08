package app

import (
	"fmt"
	"os/exec"
	"runtime"
)

func (a *App) GetRuntimePlatform() string {
	return runtime.GOOS
}

func (a *App) OpenPermissionSettings() error {
	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", "ms-settings:privacy-broadfilesystemaccess")
	default:
		return fmt.Errorf("permission settings shortcut is not available on %s", runtime.GOOS)
	}

	return cmd.Start()
}
