package terminal

import (
	"os"
	"path/filepath"
	"testing"
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
