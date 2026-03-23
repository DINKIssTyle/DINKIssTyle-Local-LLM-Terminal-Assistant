/*
    Created by DINKIssTyle on 2026.
    Copyright (C) 2026 DINKI'ssTyle. All rights reserved.
*/

package mcp

import (
	"context"
	"fmt"
	"net/url"
	"os/exec"
	"runtime"

	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

// GetCurrentTime returns the current local time in a readable format including timezone.
func GetCurrentTime() (string, error) {
	now := time.Now()
	return fmt.Sprintf("Current Local Time: %s", now.Format("2006-01-02 15:04:05 Monday MST")), nil
}

// SearchWeb performs a search using DuckDuckGo HTML and returns a summary.
func SearchWeb(query string) (string, error) {
	logVerbosef("[MCP] Searching Web for: %s", query)

	searchURL := fmt.Sprintf("https://html.duckduckgo.com/html/?q=%s", url.QueryEscape(query))

	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("disable-blink-features", "AutomationControlled"),
		chromedp.UserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
	)

	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer allocCancel()

	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()

	ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	var res string
	err := chromedp.Run(ctx,
		chromedp.ActionFunc(func(ctx context.Context) error {
			_, err := page.AddScriptToEvaluateOnNewDocument(`
				Object.defineProperty(navigator, 'webdriver', {get: () => false});
			`).Do(ctx)
			return err
		}),
		chromedp.Navigate(searchURL),
		chromedp.Sleep(2*time.Second),
		chromedp.Evaluate(`
			(() => {
				let results = [];
				document.querySelectorAll(".result__body").forEach(body => {
					let a = body.querySelector(".result__title .result__a");
					let snippet = body.querySelector(".result__snippet");
					if (a && snippet) {
						results.push("Title: " + a.innerText.trim() + "\nLink: " + a.href + "\nSnippet: " + snippet.innerText.trim());
					}
				});
				return results.length > 0 ? results.join("\n---\n") : "No results found or parsing failed.";
			})()
		`, &res),
	)

	if err != nil {
		return "", err
	}

	return res, nil
}

// SearchNamuwiki searches Namuwiki.
func SearchNamuwiki(keyword string) (string, error) {
	encodedKeyword := url.PathEscape(keyword)
	targetURL := fmt.Sprintf("https://namu.wiki/w/%s", encodedKeyword)
	return ReadPage(targetURL)
}

// SearchNaver performs a search on Naver.
func SearchNaver(query string) (string, error) {
	searchURL := fmt.Sprintf("https://search.naver.com/search.naver?&sm=top_hty&fbm=0&ie=utf8&query=%s", url.QueryEscape(query))
	return ReadPage(searchURL)
}

// ReadPage fetches the text content of a URL using a headless browser.
func ReadPage(pageURL string) (string, error) {
	logVerbosef("[MCP] Reading Page: %s", pageURL)

	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("disable-blink-features", "AutomationControlled"),
		chromedp.UserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
	)

	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer allocCancel()

	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()

	ctx, cancel = context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	var res string
	err := chromedp.Run(ctx,
		chromedp.ActionFunc(func(ctx context.Context) error {
			_, err := page.AddScriptToEvaluateOnNewDocument(`
				Object.defineProperty(navigator, 'webdriver', {get: () => false});
			`).Do(ctx)
			return err
		}),
		chromedp.Navigate(pageURL),
		chromedp.Sleep(2*time.Second),
		chromedp.Evaluate(`
			(() => {
				const noiseSelectors = ['nav', 'footer', 'aside', 'header', 'script', 'style'];
				noiseSelectors.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()));
				return document.body.innerText.replace(/\n\s*\n/g, "\n\n").trim();
			})()
		`, &res),
	)

	if err != nil {
		return "", err
	}

	if len(res) > 30000 {
		res = res[:30000] + "... (truncated)"
	}

	return res, nil
}

// ExecuteCommand runs a shell command.
func ExecuteCommand(command string) (string, error) {
	logVerbosef("[MCP] ExecuteCommand: %s", command)

	if TerminalExecutor != nil {
		return TerminalExecutor(command)
	}

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/C", command)
	} else {
		cmd = exec.Command("sh", "-c", command)
	}

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Sprintf("Error: %v\nOutput: %s", err, string(output)), nil
	}
	return string(output), nil
}
