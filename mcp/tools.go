/*
    Created by DINKIssTyle on 2026.
    Copyright (C) 2026 DINKI'ssTyle. All rights reserved.
*/

package mcp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

// GetCurrentTime returns the current local time in a readable format including timezone.
func GetCurrentTime() (string, error) {
	now := time.Now()
	return fmt.Sprintf("Current Local Time: %s", now.Format("2006-01-02 15:04:05 Monday MST")), nil
}

// SearchWeb performs a search using DuckDuckGo HTML without browser simulation to avoid App Management prompts.
func SearchWeb(query string) (string, error) {
	logVerbosef("[MCP] Searching Web for: %s", query)

	searchURL := fmt.Sprintf("https://html.duckduckgo.com/html/?q=%s", url.QueryEscape(query))
	req, err := http.NewRequest("GET", searchURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.5")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	htmlContent := string(body)

	var results []string
	linkRegex := regexp.MustCompile(`class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
	snippetRegex := regexp.MustCompile(`class="result__snippet"[^>]*href="([^"]+)"[^>]*>(.*?)</a>`)

	matches := linkRegex.FindAllStringSubmatch(htmlContent, 5)
	snippets := snippetRegex.FindAllStringSubmatch(htmlContent, 5)

	count := len(matches)
	if len(snippets) < count {
		count = len(snippets)
	}

	for i := 0; i < count; i++ {
		link := matches[i][1]
		if strings.HasPrefix(link, "//duckduckgo.com/l/?uddg=") {
			parsed, _ := url.Parse("https:" + link)
			if uddg := parsed.Query().Get("uddg"); uddg != "" {
				link = uddg
			}
		}
		title := matches[i][2]
		snippet := snippets[i][2]

		title = strings.ReplaceAll(title, "<b>", "")
		title = strings.ReplaceAll(title, "</b>", "")
		title = strings.ReplaceAll(title, "&quot;", "\"")
		title = strings.ReplaceAll(title, "&amp;", "&")
		title = strings.ReplaceAll(title, "&#x27;", "'")

		snippet = strings.ReplaceAll(snippet, "<b>", "")
		snippet = strings.ReplaceAll(snippet, "</b>", "")
		snippet = strings.ReplaceAll(snippet, "&quot;", "\"")
		snippet = strings.ReplaceAll(snippet, "&amp;", "&")
		snippet = strings.ReplaceAll(snippet, "&#x27;", "'")

		results = append(results, fmt.Sprintf("Title: %s\nLink: %s\nSnippet: %s\n", strings.TrimSpace(title), strings.TrimSpace(link), strings.TrimSpace(snippet)))
	}

	if len(results) == 0 {
		return "No results found or parsing failed.", nil
	}

	return strings.Join(results, "\n---\n"), nil
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

// ReadPage fetches the text content of a URL using a headless browser with anti-detection.
func ReadPage(pageURL string) (string, error) {
	logVerbosef("[MCP] Reading Page (Advanced + Anti-Detection): %s", pageURL)

	// 1. Anti-Detection: Configure browser with stealth flags
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("disable-blink-features", "AutomationControlled"),
		chromedp.Flag("disable-features", "TranslateUI"),
		chromedp.Flag("disable-infobars", true),
		chromedp.Flag("disable-extensions", true),
		chromedp.Flag("no-first-run", true),
		chromedp.Flag("disable-default-apps", true),
		chromedp.UserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
	)

	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), opts...)
	defer allocCancel()

	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()

	// Set a generous timeout for complex pages + Cloudflare challenge
	ctx, cancel = context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	var res string
	err := chromedp.Run(ctx,
		// 2. Anti-Detection: Override navigator.webdriver before any page loads
		chromedp.ActionFunc(func(ctx context.Context) error {
			_, err := page.AddScriptToEvaluateOnNewDocument(`
				Object.defineProperty(navigator, 'webdriver', {get: () => false});
				if (!window.chrome) { window.chrome = {}; }
				if (!window.chrome.runtime) { window.chrome.runtime = {}; }
				Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
				Object.defineProperty(navigator, 'languages', {get: () => ['ko-KR', 'ko', 'en-US', 'en']});
			`).Do(ctx)
			return err
		}),

		chromedp.Navigate(pageURL),

		// 3. Anti-Detection: Wait for Cloudflare challenge to resolve (dynamic, up to 15s)
		chromedp.ActionFunc(func(ctx context.Context) error {
			for i := 0; i < 15; i++ {
				var title string
				if err := chromedp.Evaluate(`document.title`, &title).Do(ctx); err != nil {
					return nil // Page might not be ready yet
				}
				titleLower := strings.ToLower(title)
				// Cloudflare challenge pages have these titles
				if strings.Contains(titleLower, "just a moment") ||
					strings.Contains(titleLower, "attention required") ||
					strings.Contains(titleLower, "checking your browser") ||
					strings.Contains(titleLower, "please wait") {
					logVerbosef("[MCP] Cloudflare challenge detected (title: %s), waiting... (%d/15)", title, i+1)
					time.Sleep(1 * time.Second)
					continue
				}
				// Challenge passed or not a Cloudflare page
				break
			}
			return nil
		}),

		// Wait for page content to settle after challenge
		chromedp.Sleep(2*time.Second),

		// 4. Auto-scroll logic to trigger lazy loading
		chromedp.Evaluate(`
			(async () => {
				const distance = 400;
				const delay = 100;
				for (let i = 0; i < 15; i++) {
					window.scrollBy(0, distance);
					await new Promise(r => setTimeout(r, delay));
					if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight) break;
				}
				window.scrollTo(0, 0); // Scroll back to top for extraction
			})()
		`, nil),
		chromedp.Sleep(1*time.Second),

		// 5. Smart Extraction Logic
		chromedp.Evaluate(`
			(() => {
				const noiseSelectors = [
					'nav', 'footer', 'aside', 'header', 'script', 'style', 'iframe',
					'.ads', '.menu', '.sidebar', '.nav', '.footer', '.advertisement',
					'.social-share', '.comments-section', '.related-posts'
				];
				const contentSelectors = [
					'article', 'main', '[role="main"]', '.content', '.post-content', 
					'.article-body', '.article-content', '#content', '.entry-content'
				];

				// Try to find the main content root
				let root = null;
				for (const s of contentSelectors) {
					const el = document.querySelector(s);
					if (el && el.innerText.length > 200) { // Ensure it's substantial
						root = el;
						break;
					}
				}
				if (!root) root = document.body;

				// Clone or work on a fragment to clean up
				const tempDiv = document.createElement('div');
				tempDiv.innerHTML = root.innerHTML;

				// Remove noise
				noiseSelectors.forEach(s => {
					const elements = tempDiv.querySelectorAll(s);
					elements.forEach(el => el.remove());
				});

				// Basic HTML to Markdown converter
				function toMarkdown(node) {
					let text = "";
					for (let child of node.childNodes) {
						if (child.nodeType === 3) { // Text node
							text += child.textContent;
						} else if (child.nodeType === 1) { // Element node
							const tag = child.tagName.toLowerCase();
							const inner = toMarkdown(child);
							switch(tag) {
								case 'h1': text += "\n# " + inner + "\n"; break;
								case 'h2': text += "\n## " + inner + "\n"; break;
								case 'h3': text += "\n### " + inner + "\n"; break;
								case 'p': text += "\n" + inner + "\n"; break;
								case 'br': text += "\n"; break;
								case 'b': case 'strong': text += "**" + inner + "**"; break;
								case 'i': case 'em': text += "*" + inner + "*"; break;
								case 'a': text += "[" + inner + "](" + child.href + ")"; break;
								case 'li': text += "\n- " + inner; break;
								case 'code': text += String.fromCharCode(96) + inner + String.fromCharCode(96); break;
								case 'pre': text += "\n" + String.fromCharCode(96,96,96) + "\n" + inner + "\n" + String.fromCharCode(96,96,96) + "\n"; break;
								default: text += inner;
							}
						}
					}
					return text;
				}

				return toMarkdown(tempDiv).replace(/\n\s*\n/g, "\n\n").trim();
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
