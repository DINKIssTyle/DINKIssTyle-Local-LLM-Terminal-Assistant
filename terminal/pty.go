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
	"sync"

	"github.com/aymanbagabas/go-pty"
)

type Terminal struct {
	pty    pty.Pty
	cmd    *pty.Cmd
	mu     sync.Mutex
	onData func(data string)
	cancel context.CancelFunc
}

func NewTerminal(onData func(data string)) *Terminal {
	return &Terminal{
		onData: onData,
	}
}

func (t *Terminal) Start() error {
	var shell string
	if runtime.GOOS == "windows" {
		shell = "powershell.exe"
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

	c := p.Command(shell)
	c.Env = append(os.Environ(), "TERM=xterm-256color")

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
					t.onData(string(buf[:n]))
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
