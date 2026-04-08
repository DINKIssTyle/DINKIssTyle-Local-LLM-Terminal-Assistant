/*
   Created by DINKIssTyle on 2026.
   Copyright (C) 2026 DINKI'ssTyle. All rights reserved.
*/

package terminal

import (
	"context"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/aymanbagabas/go-pty"
)

type Terminal struct {
	pty        pty.Pty
	cmd        *pty.Cmd
	mu         sync.Mutex
	onData     func(data string)
	onCwd      func(cwd string)
	cancel     context.CancelFunc
	outputTail string
	lastDataAt time.Time
	cwd        string
	shellPath  string
	shellKind  string
	pendingOSC string
}

const maxOutputTailBytes = 256 * 1024

func NewTerminal(onData func(data string), onCwd func(cwd string)) *Terminal {
	return &Terminal{
		onData: onData,
		onCwd:  onCwd,
	}
}

func (t *Terminal) Start() error {
	var shell string
	var shellArgs []string
	if runtime.GOOS == "windows" {
		shell = "powershell.exe"
		shellArgs = []string{"-NoLogo", "-NoProfile"}
	} else {
		shell = os.Getenv("SHELL")
		if shell == "" {
			if runtime.GOOS == "darwin" {
				shell = "/bin/zsh"
			} else {
				shell = "/bin/sh"
			}
		}
		// macOS GUI 앱 환경에서는 환경변수(PATH 등)가 제한적이므로 로그인 쉘(-l)로 실행하여 사용자 환경을 모두 로드합니다.
		shellArgs = []string{"-l"}
	}

	p, err := pty.New()
	if err != nil {
		return err
	}

	c := p.Command(shell, shellArgs...)
	c.Env = append(
		os.Environ(),
		"TERM=xterm-256color",
		"LANG=en_US.UTF-8",
		"LC_CTYPE=en_US.UTF-8",
	)

	if err := c.Start(); err != nil {
		p.Close()
		return err
	}

	t.pty = p
	t.cmd = c
	t.shellPath = shell
	t.shellKind = detectShellKind(shell)

	ctx, cancel := context.WithCancel(context.Background())
	t.cancel = cancel

	// Read loop
	go func() {
		buf := make([]byte, 8192)
		for {
			select {
			case <-ctx.Done():
				return
			default:
				n, err := p.Read(buf)
				if err != nil {
					if err != io.EOF {
						log.Printf("PTY read error: %v", err)
					}
					return
				}
				if n > 0 {
					chunk := string(buf[:n])
					visible := t.processTerminalChunk(chunk)
					if visible == "" {
						continue
					}
					t.appendOutput(visible)
					t.onData(visible)
				}
			}
		}
	}()

	go func() {
		time.Sleep(120 * time.Millisecond)
		if err := t.installCwdTracking(); err != nil {
			log.Printf("PTY cwd tracking init failed: %v", err)
		}
	}()

	return nil
}

func (t *Terminal) Write(data string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.pty == nil {
		return io.ErrClosedPipe
	}
	_, err := t.pty.Write([]byte(data))
	return err
}

func (t *Terminal) appendOutput(data string) {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.outputTail += data
	if len(t.outputTail) > maxOutputTailBytes {
		t.outputTail = t.outputTail[len(t.outputTail)-maxOutputTailBytes:]
	}
	t.lastDataAt = time.Now()
}

func detectShellKind(shell string) string {
	base := strings.ToLower(filepath.Base(shell))
	switch base {
	case "zsh":
		return "zsh"
	case "bash":
		return "bash"
	case "fish":
		return "fish"
	case "powershell.exe", "powershell":
		return "powershell"
	case "pwsh.exe", "pwsh":
		return "pwsh"
	default:
		if runtime.GOOS == "windows" {
			return "powershell"
		}
		return base
	}
}

func (t *Terminal) processTerminalChunk(chunk string) string {
	t.mu.Lock()
	defer t.mu.Unlock()

	combined := t.pendingOSC + chunk
	t.pendingOSC = ""

	var builder strings.Builder
	for len(combined) > 0 {
		start := strings.Index(combined, "\x1b]633;cwd=")
		if start < 0 {
			builder.WriteString(combined)
			break
		}

		builder.WriteString(combined[:start])
		rest := combined[start+len("\x1b]633;cwd="):]
		belIdx := strings.Index(rest, "\x07")
		stIdx := strings.Index(rest, "\x1b\\")

		terminatorIdx := -1
		terminatorLen := 0
		if belIdx >= 0 {
			terminatorIdx = belIdx
			terminatorLen = 1
		}
		if stIdx >= 0 && (terminatorIdx < 0 || stIdx < terminatorIdx) {
			terminatorIdx = stIdx
			terminatorLen = 2
		}

		if terminatorIdx < 0 {
			t.pendingOSC = combined[start:]
			break
		}

		cwd := strings.TrimSpace(rest[:terminatorIdx])
		if cwd != "" && cwd != t.cwd {
			t.cwd = cwd
			if t.onCwd != nil {
				go t.onCwd(cwd)
			}
		}

		combined = rest[terminatorIdx+terminatorLen:]
	}

	return builder.String()
}

func (t *Terminal) installCwdTracking() error {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.pty == nil {
		return io.ErrClosedPipe
	}

	var initScript string
	switch t.shellKind {
	case "zsh":
		initScript = "if [[ -z \"${__DKST_CWD_HOOK:-}\" ]]; then function __dkst_emit_cwd() { printf '\\033]633;cwd=%s\\a' \"$PWD\"; }; if (( ${precmd_functions[(I)__dkst_emit_cwd]} == 0 )); then precmd_functions+=(__dkst_emit_cwd); fi; typeset -gx __DKST_CWD_HOOK=1; __dkst_emit_cwd; clear; fi\r"
	case "bash":
		initScript = "if [ -z \"${__DKST_CWD_HOOK:-}\" ]; then __dkst_emit_cwd() { printf '\\033]633;cwd=%s\\a' \"$PWD\"; }; case \";$PROMPT_COMMAND;\" in *__dkst_emit_cwd* ) ;; * ) PROMPT_COMMAND=\"__dkst_emit_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}\" ;; esac; export __DKST_CWD_HOOK=1; __dkst_emit_cwd; clear; fi\r"
	case "fish":
		initScript = "if not set -q __DKST_CWD_HOOK; function __dkst_emit_cwd; printf '\\033]633;cwd=%s\\a' \"$PWD\"; end; if functions -q fish_prompt; functions -c fish_prompt __dkst_original_fish_prompt; function fish_prompt; __dkst_emit_cwd; __dkst_original_fish_prompt; end; end; set -gx __DKST_CWD_HOOK 1; __dkst_emit_cwd; clear; end\r"
	case "powershell", "pwsh":
		initScript = "if (-not $global:__DKST_CWD_HOOK) { function global:__dkst_emit_cwd { $Host.UI.Write(\"`e]633;cwd=$($PWD.Path)`a\") }; if (-not $global:__DKST_OriginalPrompt) { $global:__DKST_OriginalPrompt = $function:prompt }; function global:prompt { __dkst_emit_cwd; if ($global:__DKST_OriginalPrompt) { & $global:__DKST_OriginalPrompt } else { \"PS $($executionContext.SessionState.Path.CurrentLocation)> \" } }; $global:__DKST_CWD_HOOK = $true; __dkst_emit_cwd; Clear-Host }\r"
	default:
		return nil
	}

	_, err := t.pty.Write([]byte(initScript))
	return err
}

func (t *Terminal) CurrentDirectory() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(t.cwd)
}

func (t *Terminal) TailLines(lines int) string {
	t.mu.Lock()
	defer t.mu.Unlock()

	if lines <= 0 {
		lines = 40
	}

	normalized := strings.ReplaceAll(t.outputTail, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	split := strings.Split(normalized, "\n")
	if len(split) <= lines {
		return strings.TrimSpace(normalized)
	}

	return strings.TrimSpace(strings.Join(split[len(split)-lines:], "\n"))
}

func (t *Terminal) TailChars(maxChars int) string {
	t.mu.Lock()
	defer t.mu.Unlock()

	normalized := strings.ReplaceAll(t.outputTail, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	normalized = strings.TrimSpace(normalized)
	if maxChars <= 0 || len(normalized) <= maxChars {
		return normalized
	}

	return strings.TrimSpace(normalized[len(normalized)-maxChars:])
}

func (t *Terminal) ClearOutput() {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.outputTail = ""
	t.lastDataAt = time.Time{}
}

func (t *Terminal) OutputCursor() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.outputTail)
}

func (t *Terminal) HasOutputSince(cursor int) bool {
	t.mu.Lock()
	defer t.mu.Unlock()

	if cursor < 0 {
		cursor = 0
	}

	return len(t.outputTail) > cursor
}

func (t *Terminal) TailLinesSince(lines int, cursor int) string {
	t.mu.Lock()
	defer t.mu.Unlock()

	if lines <= 0 {
		lines = 40
	}

	start := cursor
	if start < 0 || start > len(t.outputTail) {
		start = 0
	}

	normalized := strings.ReplaceAll(t.outputTail[start:], "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	split := strings.Split(normalized, "\n")
	if len(split) <= lines {
		return strings.TrimSpace(normalized)
	}

	return strings.TrimSpace(strings.Join(split[len(split)-lines:], "\n"))
}

func (t *Terminal) TimeSinceLastOutput() time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.lastDataAt.IsZero() {
		return time.Hour
	}

	return time.Since(t.lastDataAt)
}

func (t *Terminal) Resize(cols, rows int) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.pty == nil {
		return io.ErrClosedPipe
	}
	return t.pty.Resize(cols, rows)
}

func (t *Terminal) Stop() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.cancel != nil {
		t.cancel()
	}
	if t.pty != nil {
		t.pty.Close()
	}
	if t.cmd != nil && t.cmd.Process != nil {
		t.cmd.Process.Kill()
	}
	return nil
}
