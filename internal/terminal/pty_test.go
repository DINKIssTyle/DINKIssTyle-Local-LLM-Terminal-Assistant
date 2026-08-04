package terminal

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestValidateTerminalStartDirectoryAcceptsUserDirectory(t *testing.T) {
	directory := t.TempDir()
	actual, err := validateTerminalStartDirectory(directory)
	if err != nil {
		t.Fatal(err)
	}
	if actual != filepath.Clean(directory) {
		t.Fatalf("unexpected start directory: %q", actual)
	}
}

func TestValidateTerminalStartDirectoryRejectsFilesystemRoot(t *testing.T) {
	root := filepath.Clean(filepath.VolumeName(t.TempDir()) + string(os.PathSeparator))
	if _, err := validateTerminalStartDirectory(root); err == nil {
		t.Fatalf("expected filesystem root %q to be rejected", root)
	}
}

func TestValidateTerminalStartDirectoryRejectsFile(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "not-a-directory")
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := validateTerminalStartDirectory(file.Name()); err == nil {
		t.Fatal("expected a file path to be rejected")
	}
}

func TestWindowsTerminalStartsInUserHome(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows ConPTY regression test")
	}

	home, err := resolveTerminalStartDirectory()
	if err != nil {
		t.Fatal(err)
	}
	shell, _, err := resolveTerminalShell()
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(shell) {
		t.Fatalf("PowerShell path must be absolute when Cmd.Dir is set: %q", shell)
	}

	terminal := NewTerminal(func(string) {}, func(string) {})
	if err := terminal.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = terminal.Stop() })

	if err := terminal.Write("(Get-Location).Path\r"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(strings.ToLower(terminal.TailChars(4096)), strings.ToLower(home)) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("PowerShell did not report user home %q; output: %q", home, terminal.TailChars(4096))
}

func TestProcessTerminalChunkStripsLegacyPowerShellCwdMarker(t *testing.T) {
	terminal := &Terminal{}
	output := terminal.processTerminalChunk("result\r\ne]633;cwd=C:\\Work\x07PS C:\\Work> ")
	if output != "result\r\nPS C:\\Work> " {
		t.Fatalf("unexpected visible output: %q", output)
	}
	if terminal.cwd != `C:\Work` {
		t.Fatalf("unexpected cwd: %q", terminal.cwd)
	}
}

func TestProcessTerminalChunkStripsStandardCwdMarker(t *testing.T) {
	terminal := &Terminal{}
	output := terminal.processTerminalChunk("\x1b]633;cwd=C:\\Work\x07PS C:\\Work> ")
	if output != "PS C:\\Work> " {
		t.Fatalf("unexpected visible output: %q", output)
	}
}
