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
	cancel     context.CancelFunc
	outputTail string
	lastDataAt time.Time
}

const maxOutputTailBytes = 256 * 1024

func NewTerminal(onData func(data string)) *Terminal {
	return &Terminal{
		onData: onData,
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
			shell = "/bin/sh"
		}
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
					t.appendOutput(chunk)
					t.onData(chunk)
				}
			}
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
