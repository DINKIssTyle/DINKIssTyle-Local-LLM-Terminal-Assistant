package terminal

import "testing"

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
