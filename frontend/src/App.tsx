/*
    Created by DINKIssTyle on 2026.
    Copyright (C) 2026 DINKI'ssTyle. All rights reserved.
*/

import { useState, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './App.css';
import mcpDocsContent from './assets/docs/mcp.md?raw';
import { getTranslation, Language } from './i18n/translations';
import { StartTerminal, WriteToTerminal, ResizeTerminal, FetchLLMResponse, CallTool, GetTools, GetRecentTerminalBuffer, ClearTerminalContext, StopTerminal, SetActiveTab, UpdateMCPSettings, StopLLMResponse } from "../wailsjs/go/main/App";
import { EventsOn, EventsEmit, WindowFullscreen, WindowIsFullscreen, WindowUnfullscreen } from "../wailsjs/runtime/runtime";

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderInlineMarkdown(text: string): string {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return html;
}

function isMarkdownTableSeparatorLine(line: string): boolean {
    return /^\s*\|?[\-\s:|]+\|?\s*$/.test(line.trim());
}

function looksLikeMarkdownTableRow(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.includes('|') && !/^[*-]\s+/.test(trimmed);
}

function splitMarkdownBlocks(text: string): string[] {
    const sourceLines = text.replace(/\r\n/g, '\n').split('\n');
    const blocks: string[] = [];
    let current: string[] = [];

    const flush = () => {
        const value = current.join('\n').trim();
        if (value) blocks.push(value);
        current = [];
    };

    let index = 0;
    while (index < sourceLines.length) {
        const line = sourceLines[index];
        const trimmed = line.trim();

        if (!trimmed) {
            flush();
            index += 1;
            continue;
        }

        const next = sourceLines[index + 1] || '';
        if (looksLikeMarkdownTableRow(line) && isMarkdownTableSeparatorLine(next)) {
            flush();
            const tableLines = [line, next];
            index += 2;

            while (index < sourceLines.length) {
                const tableLine = sourceLines[index];
                if (!tableLine.trim()) break;
                if (!looksLikeMarkdownTableRow(tableLine)) break;
                tableLines.push(tableLine);
                index += 1;
            }

            blocks.push(tableLines.join('\n').trim());
            continue;
        }

        current.push(line);
        index += 1;
    }

    flush();
    return blocks;
}

function renderTextBlock(block: string): string {
    const lines = block.split('\n').map(line => line.trimEnd()).filter(Boolean);
    if (lines.length === 0) return '';

    if (lines.length === 1 && /^---+$/.test(lines[0].trim())) {
        return '<hr>';
    }

    if (lines.length === 1) {
        const headingMatch = lines[0].match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
            const level = Math.min(6, headingMatch[1].length);
            return `<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`;
        }
    }

    const isTableBlock =
        lines.length >= 2 &&
        lines.every(looksLikeMarkdownTableRow) &&
        isMarkdownTableSeparatorLine(lines[1]);

    if (isTableBlock) {
        const parseTableRow = (line: string) => line
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map(cell => cell.trim());

        const headerCells = parseTableRow(lines[0]);
        const bodyRows = lines.slice(2).map(parseTableRow).filter(row => row.some(Boolean));

        return `<table><thead><tr>${headerCells.map(cell => `<th>${renderInlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${bodyRows.map(row => `<tr>${row.map(cell => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }

    if (lines.every(line => /^\d+\.\s+/.test(line))) {
        return `<ol>${lines.map(line => `<li>${renderInlineMarkdown(line.replace(/^\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
    }

    if (lines.every(line => /^[-*]\s+/.test(line))) {
        return `<ul>${lines.map(line => `<li>${renderInlineMarkdown(line.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    }

    return `<p>${lines.map(renderInlineMarkdown).join('<br>')}</p>`;
}

function stripMarkupForContext(text: string): string {
    return text
        .replace(/<analysis>([\s\S]*?)<\/analysis>/gi, '$1')
        .replace(/<\/?execution>/gi, '')
        .replace(/<progress[^>]*>([\s\S]*?)<\/progress>/gi, '$1')
        .replace(/<tasklist[^>]*>([\s\S]*?)<\/tasklist>/gi, '$1')
        .replace(/<execution_plan[^>]*>([\s\S]*?)<\/execution_plan>/gi, '$1')
        .replace(/<walkthrough[^>]*>([\s\S]*?)<\/walkthrough>/gi, '$1')
        .replace(/<report[^>]*>([\s\S]*?)<\/report>/gi, '$1')
        .replace(/<artifact[^>]*>([\s\S]*?)<\/artifact>/gi, '$1')
        .replace(/```[\s\S]*?```/g, '[code block]')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
        .replace(/[*_`>#-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isMeaningfulProgressLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^`+$/.test(trimmed)) return false;
    if (/^[-*]+$/.test(trimmed)) return false;
    return true;
}

function extractStructuredListItems(content: string): Array<{ num: string; text: string }> {
    return content
        .split('\n')
        .map((line) => line.trim())
        .filter(isMeaningfulProgressLine)
        .map((line, index) => {
            const orderedMatch = line.match(/^(\d+)\.\s*(.*)$/);
            if (orderedMatch) {
                return { num: orderedMatch[1], text: orderedMatch[2] };
            }

            const bulletMatch = line.match(/^[-*]\s*(.*)$/);
            return {
                num: String(index + 1),
                text: bulletMatch ? bulletMatch[1] : line,
            };
        })
        .filter(item => item.text.trim().length > 0);
}

function humanizeArtifactLabel(value: string): string {
    const normalized = value.trim().replace(/[_-]+/g, ' ');
    if (!normalized) return 'Artifact';

    return normalized
        .split(/\s+/)
        .map(token => token.length <= 3 ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1))
        .join(' ');
}

function renderStructuredItems(items: Array<{ num: string; text: string }>): string {
    return items
        .map(item => `<div class="progress-item"><span class="progress-num">${escapeHtml(item.num)}</span><span>${renderInlineMarkdown(item.text)}</span></div>`)
        .join('');
}

function getTagAttribute(source: string, attribute: string): string {
    const match = source.match(new RegExp(`${attribute}="([^"]*)"`, 'i'));
    return match ? match[1] : '';
}

function keepDigitsOnly(value: string): string {
    return value.replace(/[^\d]/g, '');
}

function formatThoughtDuration(durationMs: number): string {
    const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
    if (totalSeconds < 60) {
        return `Thought for ${totalSeconds}s`;
    }

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `Thought for ${minutes}m` : `Thought for ${minutes}m ${seconds}s`;
}

function stripBackspaceArtifacts(value: string): string {
    const chars: string[] = [];
    for (const char of value) {
        if (char === '\b') {
            chars.pop();
            continue;
        }
        chars.push(char);
    }
    return chars.join('');
}

function compactTerminalContext(value: string): string {
    const normalized = stripBackspaceArtifacts(value)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');

    const sourceLines = normalized.split('\n').map(line => line.trimEnd());
    const compactedLines: string[] = [];
    let blankRun = 0;

    for (const line of sourceLines) {
        const trimmed = line.trim();
        const previous = compactedLines.length > 0 ? compactedLines[compactedLines.length - 1] : '';
        const previousTrimmed = previous.trim();
        const looksLikePrompt = /^(PS [^\n>]+>|[A-Za-z]:\\.*>)\s*$/.test(trimmed);

        if (!trimmed) {
            blankRun += 1;
            if (blankRun <= 1) {
                compactedLines.push('');
            }
            continue;
        }

        blankRun = 0;
        if (looksLikePrompt && previousTrimmed === trimmed) {
            continue;
        }

        compactedLines.push(line);
    }

    return compactedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function isSyntheticToolResponseContent(value: string): boolean {
    return /^\[Tool Response from [^\]]+\]:/i.test(value.trim());
}

function safeJsonStringify(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function maskSensitiveText(value: string, apiKey: string): string {
    let masked = value;
    if (apiKey) {
        masked = masked.split(apiKey).join('[redacted-api-key]');
    }
    return masked;
}

function createEmptyDebugTrace(): DebugTrace {
    return {
        screenContext: '',
        requestMessages: '',
        requestMeta: '',
        rawResponse: '',
        parsedToolCall: '',
        toolExecutions: [],
        terminalNotes: '',
        updatedAt: null,
    };
}

function renderLooseHtmlBlock(htmlSource: string): string {
    const normalized = htmlSource
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<div[^>]*>/gi, '')
        .replace(/<strong>([\s\S]*?)<\/strong>/gi, (_, content) => `**${content.trim()}**`)
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return renderTextBlock(normalized);
}

function renderArtifactBody(content: string): string {
    const trimmed = content.trim();
    if (!trimmed) return '';

    const normalized = trimmed
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n');

    return splitMarkdownBlocks(normalized)
        .map(block => renderTextBlock(block.trim()))
        .filter(Boolean)
        .join('');
}

function renderMarkdown(text: string): string {
    if (!text) return '';

    const placeholders: string[] = [];
    const stash = (value: string) => {
        const token = `@@BLOCK_${placeholders.length}@@`;
        placeholders.push(value);
        return token;
    };

    let html = text.replace(/\r\n/g, '\n').trim();

    html = html.replace(/<analysis>([\s\S]*?)<\/analysis>/gi, (_, content) => {
        return stash(`<div class="message-block analysis-block"><span class="analysis-icon">Inspect</span><strong>${renderInlineMarkdown(content.trim())}</strong></div>`);
    });

    html = html.replace(/<\/?execution>/gi, '');

    html = html.replace(/<div\b[^>]*>[\s\S]*?<\/div>/gi, (block) => {
        return stash(`<section class="message-block">${renderLooseHtmlBlock(block)}</section>`);
    });

    html = html.replace(/<progress\b([^>]*)>([\s\S]*?)<\/progress>/gi, (_, attrs, content) => {
        const title = getTagAttribute(attrs, 'title') || 'Working Step';
        const desc = getTagAttribute(attrs, 'description');
        const items = content
            .split('\n')
            .map((line: string) => line.trim())
            .filter(isMeaningfulProgressLine)
            .map((line: string, index: number) => {
                const match = line.match(/^(\d+)\.\s*(.*)/);
                const step = match ? match[2] : line;
                const num = match ? match[1] : String(index + 1);
                return `<div class="progress-item"><span class="progress-num">${num}</span><span>${renderInlineMarkdown(step)}</span></div>`;
            })
            .join('');

        return stash(`<section class="message-block progress-block">
            <div class="progress-header"><span>${renderInlineMarkdown(title)}</span><span class="progress-meta">Progress</span></div>
            ${desc ? `<div class="progress-description">${renderInlineMarkdown(desc)}</div>` : ''}
            <div class="progress-list">${items}</div>
        </section>`);
    });

    html = html.replace(/<progress>([\s\S]*?)<\/progress>/gi, (_, content) => {
        const items = renderStructuredItems(extractStructuredListItems(content));

        return stash(`<section class="message-block progress-block">
            <div class="progress-header"><span>Working Step</span><span class="progress-meta">Progress</span></div>
            <div class="progress-list">${items}</div>
        </section>`);
    });

    html = html.replace(/<tasklist\b([^>]*)>([\s\S]*?)<\/tasklist>/gi, (_, attrs, content) => {
        const title = getTagAttribute(attrs, 'title') || 'Execution Plan';
        const desc = getTagAttribute(attrs, 'description');
        const items = renderStructuredItems(extractStructuredListItems(content));

        return stash(`<section class="message-block tasklist-block">
            <div class="progress-header">
                <span>${renderInlineMarkdown(title)}</span>
                <span class="progress-meta">Tasks</span>
            </div>
            ${desc ? `<div class="progress-description">${renderInlineMarkdown(desc)}</div>` : ''}
            <div class="progress-list">${items}</div>
        </section>`);
    });

    html = html.replace(/<execution_plan\b([^>]*)>([\s\S]*?)<\/execution_plan>/gi, (_, attrs, content) => {
        const title = getTagAttribute(attrs, 'title') || 'Execution Plan';
        const desc = getTagAttribute(attrs, 'description');
        const items = renderStructuredItems(extractStructuredListItems(content));

        return stash(`<section class="message-block tasklist-block">
            <div class="progress-header">
                <span>${renderInlineMarkdown(title)}</span>
                <span class="progress-meta">Tasks</span>
            </div>
            ${desc ? `<div class="progress-description">${renderInlineMarkdown(desc)}</div>` : ''}
            <div class="progress-list">${items}</div>
        </section>`);
    });

    html = html.replace(/<walkthrough\b([^>]*)>([\s\S]*?)<\/walkthrough>/gi, (_, attrs, content) => {
        const title = getTagAttribute(attrs, 'title') || 'What I Did';
        const desc = getTagAttribute(attrs, 'description');
        const items = renderStructuredItems(extractStructuredListItems(content));

        return stash(`<section class="message-block walkthrough-block">
            <div class="progress-header">
                <span>${renderInlineMarkdown(title)}</span>
                <span class="progress-meta">Walkthrough</span>
            </div>
            ${desc ? `<div class="progress-description">${renderInlineMarkdown(desc)}</div>` : ''}
            <div class="progress-list">${items}</div>
        </section>`);
    });

    html = html.replace(/<report\b([^>]*)>([\s\S]*?)<\/report>/gi, (_, attrs, content) => {
        const title = getTagAttribute(attrs, 'title') || 'Completion Report';
        const desc = getTagAttribute(attrs, 'description');
        const items = renderStructuredItems(extractStructuredListItems(content));

        return stash(`<section class="message-block report-block">
            <div class="progress-header">
                <span>${renderInlineMarkdown(title)}</span>
                <span class="progress-meta">Report</span>
            </div>
            ${desc ? `<div class="progress-description">${renderInlineMarkdown(desc)}</div>` : ''}
            <div class="progress-list">${items}</div>
        </section>`);
    });

    html = html.replace(/<artifact title="([^"]*)" description="([^"]*)" type="([^"]*)">([^<]*)<\/artifact>/gi, (_, title, desc, type, path) => {
        return stash(`<section class="artifact-card">
            <div class="artifact-header">
                <div class="artifact-title">${renderInlineMarkdown(title)}</div>
                <button class="open-btn" onclick="window.dispatchEvent(new CustomEvent('open-artifact', {detail: '${escapeHtml(path.trim())}'}))">Open</button>
            </div>
            <div class="artifact-type">${renderInlineMarkdown(humanizeArtifactLabel(type))}</div>
            <div class="artifact-desc">${renderInlineMarkdown(desc)}</div>
        </section>`);
    });

    html = html.replace(/<artifact\b([^>]*)>([\s\S]*?)<\/artifact>/gi, (_, attrs, content) => {
        const title = getTagAttribute(attrs, 'title') || getTagAttribute(attrs, 'name') || humanizeArtifactLabel(getTagAttribute(attrs, 'id') || 'Artifact');
        const desc = getTagAttribute(attrs, 'description');
        const type = humanizeArtifactLabel(getTagAttribute(attrs, 'type') || 'artifact');
        const body = renderArtifactBody(content);

        return stash(`<section class="artifact-card">
            <div class="artifact-header">
                <div class="artifact-title">${renderInlineMarkdown(title)}</div>
            </div>
            <div class="artifact-type">${renderInlineMarkdown(type)}</div>
            ${desc ? `<div class="artifact-desc">${renderInlineMarkdown(desc)}</div>` : ''}
            ${body ? `<div class="artifact-body">${body}</div>` : ''}
        </section>`);
    });

    html = html.replace(/<artifact([^>]*)>/gi, (_, attrs) => {
        const typeMatch = attrs.match(/type="([^"]*)"/i);
        const idMatch = attrs.match(/id="([^"]*)"/i);
        const nameMatch = attrs.match(/name="([^"]*)"/i);
        const titleMatch = attrs.match(/title="([^"]*)"/i);
        const title = titleMatch?.[1] || nameMatch?.[1] || humanizeArtifactLabel(idMatch?.[1] || 'Artifact');
        const type = humanizeArtifactLabel(typeMatch?.[1] || 'artifact');
        return stash(`<section class="artifact-card">
            <div class="artifact-header">
                <div class="artifact-title">${renderInlineMarkdown(title)}</div>
            </div>
            <div class="artifact-type">${renderInlineMarkdown(type)}</div>
        </section>`);
    });

    html = html.replace(/<\/artifact>/gi, '');

    html = html.replace(/(?:>>>|<<<)\s*EXECUTE_COMMAND:\s*"([\s\S]*?)"\s*<<</g, (_, command) => {
        return stash(`<section class="message-block command-block">
            <div class="command-header">
                <span>Run In Terminal</span>
                <span class="progress-meta">Action</span>
            </div>
            <div class="command-body"><code>${escapeHtml(command.trim())}</code></div>
        </section>`);
    });

    html = html.replace(/(?:>>>|<<<)\s*EXECUTE_COMMAND:\s*"([\s\S]*?)\s*<<</g, (_, command) => {
        return stash(`<section class="message-block command-block">
            <div class="command-header">
                <span>Run In Terminal</span>
                <span class="progress-meta">Action</span>
            </div>
            <div class="command-body"><code>${escapeHtml(command.trim())}</code></div>
        </section>`);
    });

    html = html.replace(/(?:>>>|<<<)\s*SEND_KEYS:\s*(\[[\s\S]*?\])\s*<<</g, (_, keysJson) => {
        return stash(`<section class="message-block command-block">
            <div class="command-header">
                <span>Send Keys</span>
                <span class="progress-meta">Action</span>
            </div>
            <div class="command-body"><code>${escapeHtml(keysJson.trim())}</code></div>
        </section>`);
    });

    html = html.replace(/(?:>>>|<<<)\s*([A-Z0-9_:-]+)\s*:\s*({[\s\S]*?})\s*<<</gi, (_, toolName, payloadJson) => {
        const normalizedToolName = String(toolName || '').trim().toLowerCase();
        if (!normalizedToolName || normalizedToolName === 'execute_command' || normalizedToolName === 'send_keys') {
            return _;
        }

        let displayValue = payloadJson.trim();
        try {
            const payload = parseToolPayloadObject(payloadJson);
            displayValue = summarizeGenericToolPayload(payload, payloadJson);
        } catch {
            // noop
        }

        return stash(`<section class="message-block command-block">
            <div class="command-header">
                <span>${escapeHtml(normalizedToolName.replace(/_/g, ' '))}</span>
                <span class="progress-meta">Tool</span>
            </div>
            <div class="command-body"><code>${escapeHtml(displayValue)}</code></div>
        </section>`);
    });

    html = html.replace(/<([a-zA-Z0-9_:-]+)>\s*({[\s\S]*?})\s*<\/\1>/g, (_, toolName, payloadJson) => {
        const normalizedToolName = String(toolName || '').trim().toLowerCase();
        if (!normalizedToolName || normalizedToolName === 'execution' || normalizedToolName === 'artifact') {
            return _;
        }

        let displayValue = payloadJson.trim();
        try {
            const payload = parseToolPayloadObject(payloadJson);
            displayValue = summarizeGenericToolPayload(payload, payloadJson);
        } catch {
            // noop
        }

        return stash(`<section class="message-block command-block">
            <div class="command-header">
                <span>${escapeHtml(normalizedToolName.replace(/_/g, ' '))}</span>
                <span class="progress-meta">Tool</span>
            </div>
            <div class="command-body"><code>${escapeHtml(displayValue)}</code></div>
        </section>`);
    });

    html = html.replace(/\[EXECUTE_COMMAND:\s*"([\s\S]*?)"\s*\]/gi, (_, command) => {
        return stash(`<section class="message-block command-block">
            <div class="command-header">
                <span>Run In Terminal</span>
                <span class="progress-meta">Action</span>
            </div>
            <div class="command-body"><code>${escapeHtml(command.trim())}</code></div>
        </section>`);
    });

    html = html.replace(/\[SEND_KEYS:\s*(\[[\s\S]*?\])\s*\]/gi, (_, keysJson) => {
        return stash(`<section class="message-block command-block">
            <div class="command-header">
                <span>Send Keys</span>
                <span class="progress-meta">Action</span>
            </div>
            <div class="command-body"><code>${escapeHtml(keysJson.trim())}</code></div>
        </section>`);
    });

    html = html.replace(/\[TOOL:\s*execute_command\s*({[\s\S]*?})\s*\]/gi, (_, payloadJson) => {
        try {
            const payload = JSON.parse(payloadJson);
            const normalized = normalizeExecuteCommandPayload(payload, payloadJson);
            const command = normalized?.commandText || payloadJson.trim();
            return stash(`<section class="message-block command-block">
                <div class="command-header">
                    <span>Run In Terminal</span>
                    <span class="progress-meta">Action</span>
                </div>
                <div class="command-body"><code>${escapeHtml(command)}</code></div>
            </section>`);
        } catch {
            return stash(`<section class="message-block command-block">
                <div class="command-header">
                    <span>Run In Terminal</span>
                    <span class="progress-meta">Action</span>
                </div>
                <div class="command-body"><code>${escapeHtml(payloadJson.trim())}</code></div>
            </section>`);
        }
    });

    html = html.replace(/\[TOOL:\s*send_keys\s*({[\s\S]*?})\s*\]/gi, (_, payloadJson) => {
        try {
            const payload = JSON.parse(payloadJson);
            const normalized = normalizeSendKeysPayloadObject(payload, payloadJson);
            const keys = normalized?.commandText || payloadJson.trim();
            return stash(`<section class="message-block command-block">
                <div class="command-header">
                    <span>Send Keys</span>
                    <span class="progress-meta">Action</span>
                </div>
                <div class="command-body"><code>${escapeHtml(keys)}</code></div>
            </section>`);
        } catch {
            return stash(`<section class="message-block command-block">
                <div class="command-header">
                    <span>Send Keys</span>
                    <span class="progress-meta">Action</span>
                </div>
                <div class="command-body"><code>${escapeHtml(payloadJson.trim())}</code></div>
            </section>`);
        }
    });

    html = html.replace(/\[TOOL:\s*([a-zA-Z0-9_:-]+)\s*({[\s\S]*?})\s*\]/gi, (_, toolName, payloadJson) => {
        const normalizedToolName = String(toolName || '').trim();
        if (!normalizedToolName || normalizedToolName === 'execute_command' || normalizedToolName === 'send_keys') {
            return _;
        }

        let displayValue = payloadJson.trim();
        try {
            const payload = JSON.parse(payloadJson);
            if (typeof payload.query === 'string') displayValue = payload.query;
            else if (typeof payload.url === 'string') displayValue = payload.url;
            else if (typeof payload.keyword === 'string') displayValue = payload.keyword;
            else displayValue = JSON.stringify(payload);
        } catch {
            // noop
        }

        return stash(`<section class="message-block command-block">
            <div class="command-header">
                <span>${escapeHtml(normalizedToolName.replace(/_/g, ' '))}</span>
                <span class="progress-meta">Tool</span>
            </div>
            <div class="command-body"><code>${escapeHtml(displayValue)}</code></div>
        </section>`);
    });

    html = html.replace(/\[TOOL:\s*([a-zA-Z0-9_:-]+)\s*\]/gi, (_, toolName) => {
        const normalizedToolName = String(toolName || '').trim();
        if (!normalizedToolName || normalizedToolName === 'execute_command' || normalizedToolName === 'send_keys') {
            return _;
        }

        return stash(`<section class="message-block command-block">
            <div class="command-header">
                <span>${escapeHtml(normalizedToolName.replace(/_/g, ' '))}</span>
                <span class="progress-meta">Tool</span>
            </div>
            <div class="command-body"><code>(no arguments)</code></div>
        </section>`);
    });

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, language, code) => {
        return stash(`<pre><code class="language-${escapeHtml(language || 'plain')}">${escapeHtml(code.trim())}</code></pre>`);
    });

    html = splitMarkdownBlocks(html)
        .map(block => renderTextBlock(block))
        .filter(Boolean)
        .join('');

    placeholders.forEach((block, index) => {
        html = html.replace(`@@BLOCK_${index}@@`, block);
    });

    return html;
}

interface Message {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    name?: string;
    reasoning?: string;
    reasoningDurationMs?: number;
    commandRequest?: {
        status: 'approval' | 'blocked';
        command: string;
        reason: string;
    };
}

interface Tab {
    id: string;
    name: string;
}

type DebugPanelTab = 'context' | 'request' | 'response' | 'tools' | 'terminal';

type DebugToolExecution = {
    tool: string;
    args: string;
    result: string;
};

type DebugTrace = {
    screenContext: string;
    requestMessages: string;
    requestMeta: string;
    rawResponse: string;
    parsedToolCall: string;
    toolExecutions: DebugToolExecution[];
    terminalNotes: string;
    updatedAt: number | null;
};

type TaskMemory = {
    request: string;
    stage: 'plan' | 'execute' | 'inspect' | 'finalize';
    recentRequests: string[];
    planItems: string[];
    stepResults: string[];
    latestEvidence: string[];
    draftResponse: string;
};

const ASSISTANT_DISPLAY_NAME = 'Assistant';
const DEFAULT_BLOCKED_COMMAND_PATTERNS = [
    'rm -rf /',
    'rm -rf ~',
    'mkfs',
    'dd if=',
    'shutdown',
    'reboot',
    'halt',
    'poweroff',
    ':(){ :|:& };:',
    'diskutil eraseDisk',
    'format ',
].join('\n');
const DEFAULT_APPROVAL_COMMAND_PATTERNS = [
    'rm ',
    'rmdir ',
    'mv ',
    'cp -r ',
    'chmod ',
    'chown ',
    'sudo ',
    'git clean',
    'git reset --hard',
    'docker system prune',
    'kill ',
    'pkill ',
].join('\n');

const clampTerminalFontSize = (value: number): number => {
    if (!Number.isFinite(value)) return 14;
    return Math.min(24, Math.max(10, Math.round(value)));
};

const clampChatFontSize = (value: number): number => {
    if (!Number.isFinite(value)) return 14;
    return Math.min(28, Math.max(10, Math.round(value)));
};

interface PendingCommandApproval {
    command: string;
    toolName: 'execute_command' | 'send_keys';
    toolArgs: string;
    historyToSend: Message[];
    baseSystemPrompt: string;
    responseSansCommand: string;
}

const normalizeShortcutTokens = (keys: string[]): string[] => (
    keys.map(key => key.trim().toUpperCase()).filter(Boolean)
);

type ParsedToolCall = {
    raw: string;
    toolName: string;
    commandText: string;
    parsedKeys: string[];
    toolArgs: string;
};

const TERMINAL_CONTEXT_CHAR_LIMIT = 4000;
const TASK_MEMORY_REQUEST_LIMIT = 3;
const TASK_MEMORY_PLAN_LIMIT = 6;
const TASK_MEMORY_STEP_LIMIT = 6;
const TASK_MEMORY_EVIDENCE_LIMIT = 2;
const TASK_MEMORY_RECENT_MESSAGE_LIMIT = 6;

type LLMProgressState = {
    phase: 'model-load' | 'prompt-processing';
    label: string;
    percent: number;
    active: boolean;
};

const parseSendKeysPayload = (payload: string): string[] | null => {
    try {
        const parsed = JSON.parse(payload);
        if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
};

const parseToolPayloadObject = (payload: string): Record<string, unknown> | null => {
    const trimmed = payload.trim();
    const candidates: string[] = [trimmed];

    if (trimmed.startsWith('{')) {
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let index = 0; index < trimmed.length; index += 1) {
            const char = trimmed[index];

            if (inString) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (char === '\\') {
                    escaped = true;
                    continue;
                }
                if (char === '"') {
                    inString = false;
                }
                continue;
            }

            if (char === '"') {
                inString = true;
                continue;
            }

            if (char === '{') {
                depth += 1;
                continue;
            }

            if (char === '}') {
                depth -= 1;
                if (depth === 0) {
                    const balanced = trimmed.slice(0, index + 1);
                    if (balanced !== trimmed) {
                        candidates.push(balanced);
                    }
                    break;
                }
            }
        }
    }

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // Try the next candidate.
        }
    }

    return null;
};

const normalizeWrappedString = (value: string): string => {
    const trimmed = value.trim().replace(/(?:<<<|>>>)+\s*$/g, '').trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
};

const getFirstStringField = (payload: Record<string, unknown>, keys: string[]): string | null => {
    for (const key of keys) {
        const value = payload[key];
        if (typeof value === 'string' && value.trim()) {
            return normalizeWrappedString(value);
        }
    }
    return null;
};

const getFirstStringArrayField = (payload: Record<string, unknown>, keys: string[]): string[] | null => {
    for (const key of keys) {
        const value = payload[key];
        if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim())) {
            return value.map((item) => normalizeWrappedString(item));
        }
    }
    return null;
};

const normalizeExecuteCommandPayload = (payload: Record<string, unknown> | null, rawPayload?: string): { commandText: string; toolArgs: string } | null => {
    if (payload) {
        const command = getFirstStringField(payload, ['command', 'cmd', 'arg', 'args', 'text', 'value', 'input', 'shell_command', 'shell']);
        if (command) {
            return {
                commandText: command,
                toolArgs: JSON.stringify({ command }),
            };
        }

        const commandParts = getFirstStringArrayField(payload, ['args', 'argv', 'command_parts']);
        if (commandParts && commandParts.length > 0) {
            const commandText = commandParts.join(' ');
            return {
                commandText,
                toolArgs: JSON.stringify({ command: commandText }),
            };
        }

        const stringEntries = Object.entries(payload).filter(([, value]) => typeof value === 'string' && value.trim());
        if (stringEntries.length === 1) {
            const commandText = normalizeWrappedString(String(stringEntries[0][1]));
            return {
                commandText,
                toolArgs: JSON.stringify({ command: commandText }),
            };
        }
    }

    if (rawPayload) {
        const normalized = normalizeWrappedString(rawPayload);
        if (normalized && !normalized.startsWith('{')) {
            return {
                commandText: normalized,
                toolArgs: JSON.stringify({ command: normalized }),
            };
        }
    }

    return null;
};

const normalizeSendKeysPayloadObject = (payload: Record<string, unknown> | null, rawPayload?: string): { parsedKeys: string[]; commandText: string; toolArgs: string } | null => {
    if (payload) {
        const keys = getFirstStringArrayField(payload, ['keys', 'buttons', 'sequence', 'values']);
        if (keys && keys.length > 0) {
            return {
                parsedKeys: keys,
                commandText: JSON.stringify(keys),
                toolArgs: JSON.stringify({ keys }),
            };
        }

        const singleKey = getFirstStringField(payload, ['key', 'arg', 'text', 'value']);
        if (singleKey) {
            return {
                parsedKeys: [singleKey],
                commandText: JSON.stringify([singleKey]),
                toolArgs: JSON.stringify({ keys: [singleKey] }),
            };
        }
    }

    if (rawPayload) {
        const parsedKeys = parseSendKeysPayload(rawPayload);
        if (parsedKeys && parsedKeys.length > 0) {
            return {
                parsedKeys,
                commandText: JSON.stringify(parsedKeys),
                toolArgs: JSON.stringify({ keys: parsedKeys }),
            };
        }
    }

    return null;
};

const summarizeGenericToolPayload = (payload: Record<string, unknown> | null, rawPayload: string): string => {
    if (payload && typeof payload === 'object') {
        if (typeof payload.query === 'string') return payload.query;
        if (typeof payload.url === 'string') return payload.url;
        if (typeof payload.keyword === 'string') return payload.keyword;
        if (typeof payload.command === 'string') return payload.command;
        if (typeof payload.arg === 'string') return payload.arg;
        if (typeof payload.text === 'string') return payload.text;
        return JSON.stringify(payload);
    }

    return rawPayload.trim();
};

const parseToolCallFromResponse = (response: string): ParsedToolCall | null => {
    const executeRegex = /(?:>>>|<<<)\s*EXECUTE_COMMAND:\s*"([\s\S]*?)"\s*<<</;
    const forgivingExecuteRegex = /(?:>>>|<<<)\s*EXECUTE_COMMAND:\s*"([\s\S]*?)\s*<<</;
    const sendKeysRegex = /(?:>>>|<<<)\s*SEND_KEYS:\s*(\[[\s\S]*?\])\s*<<</;
    const genericAngleToolRegex = /(?:>>>|<<<)\s*([A-Z0-9_:-]+)\s*:\s*({[\s\S]*?})\s*<<</i;
    const xmlToolRegex = /<([a-zA-Z0-9_:-]+)>\s*({[\s\S]*?})\s*<\/\1>/i;

    // XML-style bare content: <execute_command>cmd text</execute_command>
    const xmlExecuteCommandRegex = /<execute_command>\s*([\s\S]*?)\s*<\/execute_command>/i;
    const xmlSendKeysRegex = /<send_keys>\s*(\[[\s\S]*?\])\s*<\/send_keys>/i;
    const xmlBareToolRegex = /<([a-zA-Z0-9_:-]+)>\s*([\s\S]*?)\s*<\/\1>/i;
    const bracketExecuteRegex = /\[EXECUTE_COMMAND:\s*"([\s\S]*?)"\s*\]/i;
    const bracketSendKeysRegex = /\[SEND_KEYS:\s*(\[[\s\S]*?\])\s*\]/i;
    const bracketToolRegex = /\[TOOL:\s*([a-zA-Z0-9_:-]+)\s*({[\s\S]*?})\s*\]/i;
    const bracketToolNoArgsRegex = /\[TOOL:\s*([a-zA-Z0-9_:-]+)\s*\]/i;

    // Bare fallback patterns: no >>> <<< or [] delimiters
    const bareExecuteRegex = /(?:^|\n)\s*EXECUTE_COMMAND:\s*"([\s\S]*?)"\s*(?:\n|$)/i;
    const bareSendKeysRegex = /(?:^|\n)\s*SEND_KEYS:\s*(\[[\s\S]*?\])\s*(?:\n|$)/i;
    const bareGenericToolRegex = /(?:^|\n)\s*([A-Z][A-Z0-9_]+)\s*:\s*({[\s\S]*?})\s*(?:\n|$)/;

    const commandMatch = response.match(executeRegex);
    if (commandMatch) {
        const command = normalizeWrappedString(commandMatch[1]);
        return {
            raw: commandMatch[0],
            toolName: 'execute_command',
            commandText: command,
            parsedKeys: [],
            toolArgs: JSON.stringify({ command }),
        };
    }

    const forgivingCommandMatch = response.match(forgivingExecuteRegex);
    if (forgivingCommandMatch) {
        const command = normalizeWrappedString(forgivingCommandMatch[1].replace(/"$/, ''));
        return {
            raw: forgivingCommandMatch[0],
            toolName: 'execute_command',
            commandText: command,
            parsedKeys: [],
            toolArgs: JSON.stringify({ command }),
        };
    }

    const keyMatch = response.match(sendKeysRegex);
    if (keyMatch) {
        const parsedKeys = parseSendKeysPayload(keyMatch[1]) || [];
        return {
            raw: keyMatch[0],
            toolName: 'send_keys',
            commandText: keyMatch[1],
            parsedKeys,
            toolArgs: JSON.stringify({ keys: parsedKeys }),
        };
    }

    const bracketExecuteMatch = response.match(bracketExecuteRegex);
    if (bracketExecuteMatch) {
        const command = normalizeWrappedString(bracketExecuteMatch[1]);
        return {
            raw: bracketExecuteMatch[0],
            toolName: 'execute_command',
            commandText: command,
            parsedKeys: [],
            toolArgs: JSON.stringify({ command }),
        };
    }

    const bracketSendKeysMatch = response.match(bracketSendKeysRegex);
    if (bracketSendKeysMatch) {
        const parsedKeys = parseSendKeysPayload(bracketSendKeysMatch[1]) || [];
        return {
            raw: bracketSendKeysMatch[0],
            toolName: 'send_keys',
            commandText: bracketSendKeysMatch[1],
            parsedKeys,
            toolArgs: JSON.stringify({ keys: parsedKeys }),
        };
    }

    // --- Bare fallback (no delimiters) ---
    const bareExecuteMatch = response.match(bareExecuteRegex);
    if (bareExecuteMatch) {
        const command = normalizeWrappedString(bareExecuteMatch[1]);
        return {
            raw: bareExecuteMatch[0],
            toolName: 'execute_command',
            commandText: command,
            parsedKeys: [],
            toolArgs: JSON.stringify({ command }),
        };
    }

    const bareSendKeysMatch = response.match(bareSendKeysRegex);
    if (bareSendKeysMatch) {
        const parsedKeys = parseSendKeysPayload(bareSendKeysMatch[1]) || [];
        return {
            raw: bareSendKeysMatch[0],
            toolName: 'send_keys',
            commandText: bareSendKeysMatch[1],
            parsedKeys,
            toolArgs: JSON.stringify({ keys: parsedKeys }),
        };
    }

    const genericAngleToolMatch = response.match(genericAngleToolRegex);
    if (genericAngleToolMatch) {
        const toolName = genericAngleToolMatch[1].toLowerCase();
        if (toolName !== 'execute_command' && toolName !== 'send_keys') {
            try {
                const payload = parseToolPayloadObject(genericAngleToolMatch[2]);
                return {
                    raw: genericAngleToolMatch[0],
                    toolName,
                    commandText: summarizeGenericToolPayload(payload, genericAngleToolMatch[2]),
                    parsedKeys: [],
                    toolArgs: JSON.stringify(payload || {}),
                };
            } catch {
                return null;
            }
        }
    }

    const xmlToolMatch = response.match(xmlToolRegex);
    if (xmlToolMatch) {
        const toolName = xmlToolMatch[1].toLowerCase();
        if (toolName !== 'execution' && toolName !== 'artifact') {
            try {
                const payload = parseToolPayloadObject(xmlToolMatch[2]);
                return {
                    raw: xmlToolMatch[0],
                    toolName,
                    commandText: summarizeGenericToolPayload(payload, xmlToolMatch[2]),
                    parsedKeys: [],
                    toolArgs: JSON.stringify(payload || {}),
                };
            } catch {
                return null;
            }
        }
    }

    // XML-style bare content: <execute_command>cmd text</execute_command>
    const xmlExecMatch = response.match(xmlExecuteCommandRegex);
    if (xmlExecMatch) {
        const command = normalizeWrappedString(xmlExecMatch[1].replace(/^["']|["']$/g, ''));
        return {
            raw: xmlExecMatch[0],
            toolName: 'execute_command',
            commandText: command,
            parsedKeys: [],
            toolArgs: JSON.stringify({ command }),
        };
    }

    const xmlKeysMatch = response.match(xmlSendKeysRegex);
    if (xmlKeysMatch) {
        const parsedKeys = parseSendKeysPayload(xmlKeysMatch[1]) || [];
        return {
            raw: xmlKeysMatch[0],
            toolName: 'send_keys',
            commandText: xmlKeysMatch[1],
            parsedKeys,
            toolArgs: JSON.stringify({ keys: parsedKeys }),
        };
    }

    // Catch-all XML bare tool: <tool_name>content</tool_name>
    const STRUCTURAL_TAGS = new Set(['analysis', 'progress', 'tasklist', 'execution_plan', 'walkthrough', 'report', 'execution', 'artifact', 'reasoning', 'thought', 'thinking', 'reflection']);
    const xmlBareMatch = response.match(xmlBareToolRegex);
    if (xmlBareMatch) {
        const toolName = xmlBareMatch[1].toLowerCase();
        if (!STRUCTURAL_TAGS.has(toolName)) {
            const rawContent = xmlBareMatch[2].trim();
            // Try to parse as JSON first
            try {
                const payload = parseToolPayloadObject(rawContent);
                if (payload) {
                    return {
                        raw: xmlBareMatch[0],
                        toolName,
                        commandText: summarizeGenericToolPayload(payload, rawContent),
                        parsedKeys: [],
                        toolArgs: JSON.stringify(payload),
                    };
                }
            } catch { /* not JSON, use as raw string */ }
            // Use raw content as the argument
            return {
                raw: xmlBareMatch[0],
                toolName,
                commandText: rawContent,
                parsedKeys: [],
                toolArgs: JSON.stringify({ input: rawContent }),
            };
        }
    }

    const bracketMatch = response.match(bracketToolRegex);
    if (!bracketMatch) {
        const noArgsMatch = response.match(bracketToolNoArgsRegex);
        if (!noArgsMatch) return null;

        const toolName = noArgsMatch[1].toLowerCase();
        return {
            raw: noArgsMatch[0],
            toolName,
            commandText: '',
            parsedKeys: [],
            toolArgs: '{}',
        };
    }

    try {
        const toolName = bracketMatch[1].toLowerCase();
        const payload = parseToolPayloadObject(bracketMatch[2]);
        if (toolName === 'execute_command') {
            const normalized = normalizeExecuteCommandPayload(payload, bracketMatch[2]);
            if (!normalized) return null;
            return {
                raw: bracketMatch[0],
                toolName,
                commandText: normalized.commandText,
                parsedKeys: [],
                toolArgs: normalized.toolArgs,
            };
        }

        if (toolName === 'send_keys') {
            const normalized = normalizeSendKeysPayloadObject(payload, bracketMatch[2]);
            if (!normalized) return null;
            return {
                raw: bracketMatch[0],
                toolName,
                commandText: normalized.commandText,
                parsedKeys: normalized.parsedKeys,
                toolArgs: normalized.toolArgs,
            };
        }

        if (payload && typeof payload === 'object') {
            return {
                raw: bracketMatch[0],
                toolName,
                commandText: summarizeGenericToolPayload(payload, bracketMatch[2]),
                parsedKeys: [],
                toolArgs: JSON.stringify(payload),
            };
        }
    } catch {
        return null;
    }

    // --- Smart fallback: heuristic detection for unexpected formats ---
    // Catches patterns like: execute_command: "cmd", Command: `cmd`, RUN: "cmd", etc.
    const heuristicExecMatch = response.match(
        /(?:execute_command|execute|run_command|run|command)\s*[:=]\s*(?:"([^"]+)"|`([^`]+)`|'([^']+)')/i
    );
    if (heuristicExecMatch) {
        const command = normalizeWrappedString(heuristicExecMatch[1] || heuristicExecMatch[2] || heuristicExecMatch[3]);
        if (command) {
            return {
                raw: heuristicExecMatch[0],
                toolName: 'execute_command',
                commandText: command,
                parsedKeys: [],
                toolArgs: JSON.stringify({ command }),
            };
        }
    }

    // Heuristic for send_keys-like patterns
    const heuristicKeysMatch = response.match(
        /(?:send_keys|keys|keypress)\s*[:=]\s*(\[[\s\S]*?\])/i
    );
    if (heuristicKeysMatch) {
        const parsedKeys = parseSendKeysPayload(heuristicKeysMatch[1]) || [];
        if (parsedKeys.length > 0) {
            return {
                raw: heuristicKeysMatch[0],
                toolName: 'send_keys',
                commandText: heuristicKeysMatch[1],
                parsedKeys,
                toolArgs: JSON.stringify({ keys: parsedKeys }),
            };
        }
    }

    // Log suspected unparsed tool calls for debugging
    const toolCallHints = /(?:execute_command|send_keys|EXECUTE|SEND_KEYS|TOOL|command\s*:|run\s*:)/i;
    if (toolCallHints.test(response)) {
        console.warn('[Parser] Suspected unparsed tool call in LLM response:', response.slice(-500));
    }

    return null;
};

const isAppNewTabShortcut = (keys: string[]): boolean => {
    const normalized = normalizeShortcutTokens(keys);
    const hasModifier = normalized.includes('CTRL') || normalized.includes('CONTROL') || normalized.includes('CMD') || normalized.includes('COMMAND') || normalized.includes('META');
    return hasModifier && normalized.includes('T');
};

const isAppCloseTabShortcut = (keys: string[]): boolean => {
    const normalized = normalizeShortcutTokens(keys);
    const hasModifier = normalized.includes('CTRL') || normalized.includes('CONTROL') || normalized.includes('CMD') || normalized.includes('COMMAND') || normalized.includes('META');
    return hasModifier && normalized.includes('W');
};

const LLMProgressCard = ({ progress }: { progress: LLMProgressState | null }) => {
    if (!progress?.active) return null;
    const normalizedPercent = Math.max(0, Math.min(100, progress.percent));
    const isIndeterminate = normalizedPercent <= 0;
    const labelText = progress.label.replace(/\s+\d+%$/, '');

    return (
        <div className={`llm-progress-card ${progress.phase} ${isIndeterminate ? 'indeterminate' : ''}`}>
            <div className="llm-progress-text">
                <span className="llm-progress-label">{labelText}</span>
                <span className="llm-progress-percent">{isIndeterminate ? '...' : `${Math.round(normalizedPercent)}%`}</span>
            </div>
            <div className="llm-progress-track">
                <div className="llm-progress-fill" style={{ width: isIndeterminate ? '34%' : `${normalizedPercent}%` }}></div>
            </div>
        </div>
    );
};

const getAppTabSwitchIndex = (keys: string[]): number | null => {
    const normalized = normalizeShortcutTokens(keys);
    const hasModifier = normalized.includes('CTRL') || normalized.includes('CONTROL') || normalized.includes('CMD') || normalized.includes('COMMAND') || normalized.includes('META') || normalized.includes('OS') || normalized.includes('SUPER') || normalized.includes('WIN') || normalized.includes('WINDOWS');
    if (!hasModifier) return null;

    const digit = normalized.find(token => /^[0-9]$/.test(token));
    if (!digit) return null;
    return digit === '0' ? 9 : Number(digit) - 1;
};

const shouldInspectTerminalAfterCommand = (command: string): boolean => {
    return command.trim().length > 0;
};

const COMPLEX_REQUEST_KEYWORDS = [
    'complex',
    '복잡',
    '단계',
    'multi-step',
    'workflow',
    'plan',
    'task',
    '태스크',
    '워크스루',
    'walkthrough',
    '구현',
    '설계',
    '리팩터',
    'refactor',
    'investigate',
    '분석',
    '검토',
    'end-to-end',
    '보고',
];


const SCREEN_CONTEXT_KEYWORDS = /화면|스크린|보이는|visible|ui|layout|버튼|입력창|chat|대화|terminal|터미널|prompt|프롬프트|nano|pico|vim|editor|편집기|pane|패널/i;

const clampText = (value: string, maxLength: number): string => {
    const normalized = value.trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength).trimEnd()}...`;
};

const clampTextFromEnd = (value: string, maxLength: number): string => {
    const normalized = value.trim();
    if (normalized.length <= maxLength) return normalized;
    return `...${normalized.slice(normalized.length - maxLength).trimStart()}`;
};

const extractTagContents = (value: string, tagName: string): string[] => {
    const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
    const matches: string[] = [];
    let match: RegExpExecArray | null = null;

    while ((match = regex.exec(value)) !== null) {
        const content = stripMarkupForContext(match[1] || '');
        if (content) {
            matches.push(content);
        }
    }

    return matches;
};

const dedupePreserveOrder = (values: string[]): string[] => {
    const seen = new Set<string>();
    const deduped: string[] = [];

    for (const value of values) {
        const normalized = value.trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        deduped.push(normalized);
    }

    return deduped;
};

const getMeaningfulUserHistory = (history: Message[]): Message[] => (
    history.filter(message => message.role === 'user' && message.content.trim() && !isSyntheticToolResponseContent(message.content))
);

const inferTaskStage = (history: Message[]): TaskMemory['stage'] => {
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        const content = message.content.trim();
        if (!content) continue;

        if (message.role === 'tool') return 'inspect';
        if (message.role === 'user') return 'plan';
        if (message.role === 'assistant') {
            return parseToolCallFromResponse(content) ? 'execute' : 'finalize';
        }
    }

    return 'plan';
};

const summarizeToolContentForMemory = (message: Message): string => {
    const normalized = stripMarkupForContext(message.content);
    if (!normalized) {
        return message.name ? `${message.name}: (empty result)` : '(empty result)';
    }

    const commandMatch = normalized.match(/Command:\s*`?([^`\n]+)`?/i);
    const statusMatch = normalized.match(/Status:\s*([\s\S]*)$/i);
    const commandText = commandMatch?.[1]?.trim();
    const statusText = statusMatch ? clampText(stripMarkupForContext(statusMatch[1]), 120) : clampText(normalized, 120);
    const toolName = message.name || 'tool';

    if (commandText) {
        if (statusText === `Sent to terminal: ${commandText}`) {
            return `${toolName}: ${commandText}`;
        }
        return `${toolName}: ${commandText} -> ${statusText}`;
    }

    return `${toolName}: ${statusText}`;
};

const summarizeMessageForMemory = (message: Message): string => {
    if (message.role === 'tool') {
        return summarizeToolContentForMemory(message);
    }

    const normalized = stripToolCallMarkup(stripMarkupForContext(message.content));
    if (!normalized) return '';

    if (message.role === 'assistant') {
        return clampText(normalized, 220);
    }

    if (message.role === 'system') {
        return clampText(normalized, 180);
    }

    return clampText(normalized, 200);
};

const collectPlanItems = (history: Message[]): string[] => {
    const collected: string[] = [];

    for (const message of history) {
        if (message.role !== 'assistant') continue;

        const sections = [
            ...extractTagContents(message.content, 'tasklist'),
            ...extractTagContents(message.content, 'execution_plan'),
            ...extractTagContents(message.content, 'progress'),
        ];

        for (const section of sections) {
            const items = extractStructuredListItems(section);
            for (const item of items) {
                const text = clampText(stripMarkupForContext(item.text), 140);
                if (!text || collected.includes(text)) continue;
                collected.push(text);
                if (collected.length >= TASK_MEMORY_PLAN_LIMIT) {
                    return collected;
                }
            }
        }
    }

    return collected;
};

const buildTaskMemory = (history: Message[]): TaskMemory => {
    const meaningfulUsers = getMeaningfulUserHistory(history);
    const recentRequests = meaningfulUsers
        .slice(-TASK_MEMORY_REQUEST_LIMIT)
        .map(message => clampText(stripMarkupForContext(message.content), 180));
    const request = recentRequests[recentRequests.length - 1] || '';

    const planItems = collectPlanItems(history);
    const stepResults = dedupePreserveOrder(history
        .filter(message => message.role === 'tool' || (message.role === 'assistant' && !parseToolCallFromResponse(message.content) && message.content.trim()))
        .map(summarizeMessageForMemory)
        .filter(Boolean)
    ).slice(-TASK_MEMORY_STEP_LIMIT);

    const latestEvidence = dedupePreserveOrder(history
        .filter(message => {
            if (message.role === 'tool') return true;
            if (message.role === 'user' && /\[Latest user request\]/.test(message.content)) return true;
            return false;
        })
        .map(summarizeMessageForMemory)
        .filter(Boolean)
    ).slice(-TASK_MEMORY_EVIDENCE_LIMIT);

    const latestAssistant = [...history]
        .reverse()
        .find(message => message.role === 'assistant' && !parseToolCallFromResponse(message.content) && stripToolCallMarkup(message.content).trim());
    const draftResponse = latestAssistant ? clampText(stripToolCallMarkup(stripMarkupForContext(latestAssistant.content)), 180) : '';
    const finalDraftResponse = stepResults.includes(draftResponse) ? '' : draftResponse;

    return {
        request,
        stage: inferTaskStage(history),
        recentRequests,
        planItems,
        stepResults,
        latestEvidence,
        draftResponse: finalDraftResponse,
    };
};

const renderTaskMemory = (memory: TaskMemory): string => {
    const sections: string[] = [
        `CURRENT_REQUEST: ${memory.request || '(none)'}`,
        `CURRENT_STAGE: ${memory.stage}`,
    ];

    if (memory.recentRequests.length > 0) {
        sections.push(`RECENT_REQUESTS:\n${memory.recentRequests.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    }

    if (memory.planItems.length > 0) {
        sections.push(`WORKING_PLAN:\n${memory.planItems.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    }

    if (memory.stepResults.length > 0) {
        sections.push(`STEP_RESULTS:\n${memory.stepResults.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    }

    if (memory.latestEvidence.length > 0) {
        sections.push(`LATEST_EVIDENCE:\n${memory.latestEvidence.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    }

    if (memory.draftResponse) {
        sections.push(`DRAFT_RESPONSE:\n${memory.draftResponse}`);
    }

    sections.push('Use TASK_MEMORY as the main prior-state summary. Verify with tools for system facts or fresh output.');

    return sections.join('\n\n');
};

const buildCompactHistory = (history: Message[]): Message[] => {
    return history
        .filter((message, index) => {
            if (index === 0 && message.role === 'assistant') return false;
            if (message.role === 'system' && /^🔧 Executing /.test(message.content.trim())) return false;
            if (message.role === 'assistant' && !stripToolCallMarkup(stripMarkupForContext(message.content)).trim()) return false;
            return Boolean(message.content.trim());
        })
        .slice(-TASK_MEMORY_RECENT_MESSAGE_LIMIT)
        .map((message) => {
            const maxLength = message.role === 'tool' ? 220 : message.role === 'assistant' ? 240 : 180;
            return {
                ...message,
                content: clampTextFromEnd(message.content, maxLength),
            };
        });
};

const shouldAttachScreenContext = (history: Message[]): boolean => {
    const latestUser = [...history]
        .reverse()
        .find(message => message.role === 'user' && message.content.trim() && !isSyntheticToolResponseContent(message.content));
    const latestRequest = latestUser?.content || '';
    if (SCREEN_CONTEXT_KEYWORDS.test(latestRequest)) return true;

    const latestAssistant = [...history].reverse().find(message => message.role === 'assistant' && message.content.trim());
    if (latestAssistant && parseToolCallFromResponse(latestAssistant.content)?.toolName === 'send_keys') {
        return true;
    }

    return false;
};

const buildCompactVisibleChat = (history: Message[]): string => {
    return history
        .filter(message => !isSyntheticToolResponseContent(message.content))
        .slice(-2)
        .map(message => {
            const roleLabel = message.role === 'user' ? 'U' : message.role === 'assistant' ? 'A' : message.role === 'tool' ? 'T' : 'S';
            return `${roleLabel}: ${clampText(stripMarkupForContext(message.content) || '(empty)', 120)}`;
        })
        .join('\n');
};

const shouldUseComplexTaskMode = (request: string): boolean => {
    const normalized = request.trim();
    if (!normalized) return false;

    const sentenceCount = normalized.split(/[.!?\n]/).map(token => token.trim()).filter(Boolean).length;
    const lineCount = normalized.split('\n').map(token => token.trim()).filter(Boolean).length;
    const hasCodeLikeContent = /```|`[^`]+`|[{}[\]();]/.test(normalized);
    const hasPathOrCommandLikeContent = /(^|\s)(\/|~|[A-Za-z]:\\)|\b[a-z0-9_-]+\.[a-z0-9]{1,8}\b/i.test(normalized);

    return normalized.length >= 220
        || sentenceCount >= 4
        || lineCount >= 5
        || (sentenceCount >= 2 && hasCodeLikeContent)
        || (sentenceCount >= 2 && hasPathOrCommandLikeContent);
};

const shouldContinueAfterActionlessAnalysis = (response: string, userRequest: string): boolean => {
    const normalized = response.trim();
    if (!normalized) return false;

    const hasToolCall =
        /\[TOOL:\s*[a-zA-Z0-9_:-]+\s*(?:{[\s\S]*?})?\s*\]/i.test(normalized)
        || /\[(?:EXECUTE_COMMAND|SEND_KEYS):/i.test(normalized)
        || /(?:>>>|<<<)\s*(?:EXECUTE_COMMAND|SEND_KEYS):/i.test(normalized)
        || /(?:>>>|<<<)\s*[A-Z0-9_:-]+\s*:\s*{[\s\S]*?}\s*<<</i.test(normalized)
        || /<(?!\/?(?:analysis|progress|tasklist|execution_plan|walkthrough|report|artifact)\b)([a-zA-Z0-9_:-]+)>\s*{[\s\S]*?}\s*<\/\1>/i.test(normalized);

    if (hasToolCall) return false;

    const hasCompletionEvidence =
        /<walkthrough\b[\s\S]*?<\/walkthrough>/i.test(normalized)
        || /<report\b[\s\S]*?<\/report>/i.test(normalized)
        || /<artifact\b[\s\S]*?<\/artifact>/i.test(normalized);

    if (hasCompletionEvidence) return false;

    const hasAnalysisOnly = /<analysis\b[\s\S]*?<\/analysis>/i.test(normalized);
    const requestLooksActionable =
        /[`"'\\/]/.test(userRequest)
        || /\b[a-z0-9_-]+\.[a-z0-9]{1,8}\b/i.test(userRequest)
        || /\bhttps?:\/\//i.test(userRequest)
        || /(^|\s)(\/|~|[A-Za-z]:\\)/.test(userRequest);

    return hasAnalysisOnly && requestLooksActionable;
};

const detectWindowsPowerShellSyntaxIssue = (command: string): string | null => {
    const normalized = command.trim().toLowerCase();
    if (!normalized) return null;

    const patterns: Array<{ pattern: RegExp; message: string }> = [
        { pattern: /\bif\s+exist\b/, message: 'Use PowerShell syntax instead of cmd.exe syntax. Replace `if exist` with `if (Test-Path ...) { ... }`.' },
        { pattern: /\bdir\b(?:\s|$)/, message: 'Use a PowerShell cmdlet such as `Get-ChildItem` instead of `dir`.' },
        { pattern: /\bcopy\b(?:\s|$)/, message: 'Use `Copy-Item` instead of `copy` on Windows PowerShell.' },
        { pattern: /\bdel\b(?:\s|$)/, message: 'Use `Remove-Item` instead of `del` on Windows PowerShell.' },
        { pattern: /\btype\b(?:\s|$)/, message: 'Use `Get-Content` instead of `type` on Windows PowerShell.' },
        { pattern: /\bset\s+[a-z_][a-z0-9_]*=/, message: 'Use `$env:VAR = \"value\"` instead of `set VAR=value` on Windows PowerShell.' },
        { pattern: /%[a-z0-9_]+%/i, message: 'Use `$env:VAR` instead of `%VAR%` on Windows PowerShell.' },
        { pattern: /\b&&\b|\b\|\|\b/, message: 'Use PowerShell control flow such as `;`, `if`, `-and`, or `-or` instead of `&&` or `||`.' },
        { pattern: /\\"/, message: 'Do not use cmd-style escaped quotes such as `\\\"` on Windows PowerShell. Use PowerShell quoting instead, such as single-quoted strings or doubled quotes inside a PowerShell string.' },
    ];

    const match = patterns.find(({ pattern }) => pattern.test(normalized));
    return match ? match.message : null;
};

const buildTaskWorkflowPrompt = (complexRequest: boolean): string => {
    if (!complexRequest) return '';

    return `
5. COMPLEX TASK MODE: The app already suspects this request is complex, but you must still judge the request by meaning, not by keywords or UI language. Treat it as complex when it needs multiple steps, implementation, investigation, refactoring, review, or an execution plan.
6. COMPLEX TASK FORMAT: For the first substantial assistant response, include these blocks in order when they add value:
   <analysis>Short diagnosis of the request and constraints</analysis>
   <tasklist title="Execution Plan" description="What will be handled end-to-end">
   1. Define or confirm the task breakdown
   2. Execute the tasks in order
   3. Verify outcomes
   </tasklist>
   After meaningful work is completed, include:
   <walkthrough title="What I Did" description="Concrete execution trace">
   1. ...
   2. ...
   </walkthrough>
   <report title="Completion Report" description="Outcome, verification, and remaining risk">
   1. ...
   2. ...
   </report>
7. COMPLEX TASK BEHAVIOR: Do not only propose a plan. Actually carry out the work, keep the task list aligned with the work performed, and finish with a completion report.`;
};

const FOLLOW_UP_LLM_TIMEOUT_MS = 20000;

const stripToolCallMarkup = (value: string): string => (
    value
        .replace(/<\/?execution>/gi, '')
        .replace(/\[TOOL:\s*[a-zA-Z0-9_:-]+\s*{[\s\S]*?}\s*\]/g, '')
        .replace(/\[TOOL:\s*[a-zA-Z0-9_:-]+\s*\]/g, '')
        .replace(/(?:>>>|<<<)\s*EXECUTE_COMMAND:\s*"[\s\S]*?"\s*<<</g, '')
        .replace(/(?:>>>|<<<)\s*SEND_KEYS:\s*\[[\s\S]*?\]\s*<<</g, '')
        .replace(/(?:>>>|<<<)\s*[A-Z0-9_:-]+\s*:\s*{[\s\S]*?}\s*<<</g, '')
        .replace(/<(?!\/?(?:analysis|progress|tasklist|execution_plan|walkthrough|report|artifact)\b)([a-zA-Z0-9_:-]+)>\s*{[\s\S]*?}\s*<\/\1>/g, '')
        .replace(/\[EXECUTE_COMMAND:\s*"[\s\S]*?"\s*\]/g, '')
        .replace(/\[SEND_KEYS:\s*\[[\s\S]*?\]\s*\]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
);

const renderAvailableToolsForPrompt = (tools: Array<{ name: string; description?: string; inputSchema?: any }>): string => {
    if (!tools.length) {
        return 'AVAILABLE_TOOLS:\n- (none)';
    }

    const lines = tools.map((tool) => {
        const propertyNames = Object.keys(tool.inputSchema?.properties || {});
        const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
        const argsText = propertyNames.length
            ? ` args: ${propertyNames.map((name) => `${name}${required.includes(name) ? '*' : ''}`).join(', ')}`
            : ' args: none';
        return `- ${tool.name}: ${(tool.description || '').trim()}${argsText}`;
    });

    lines.push('- Prefer search_web for current/latest internet information when it is available.');
    lines.push('- Use read_web_page only for a specific URL or when the user explicitly asks to inspect a page.');

    return `AVAILABLE_TOOLS:\n${lines.join('\n')}`;
};

const needsContinuationAfterPlan = (response: string): boolean => {
    const normalized = response.trim();
    if (!normalized) return false;

    const hasPlanBlock =
        /<tasklist\b[\s\S]*?<\/tasklist>/i.test(normalized)
        || /<execution_plan\b[\s\S]*?<\/execution_plan>/i.test(normalized);
    if (!hasPlanBlock) return false;

    const hasExecutionEvidence =
        /<walkthrough\b[\s\S]*?<\/walkthrough>/i.test(normalized)
        || /<report\b[\s\S]*?<\/report>/i.test(normalized)
        || /<artifact\b[\s\S]*?<\/artifact>/i.test(normalized)
        || /\[TOOL:\s*[a-zA-Z0-9_:-]+\s*{[\s\S]*?}\s*\]/i.test(normalized)
        || /\[TOOL:\s*[a-zA-Z0-9_:-]+\s*\]/i.test(normalized)
        || /\[(?:EXECUTE_COMMAND|SEND_KEYS):/i.test(normalized)
        || /(?:>>>|<<<)\s*(?:EXECUTE_COMMAND|SEND_KEYS):/i.test(normalized)
        || /(?:>>>|<<<)\s*[A-Z0-9_:-]+\s*:\s*{[\s\S]*?}\s*<<</i.test(normalized)
        || /<(?!\/?(?:analysis|progress|tasklist|execution_plan|walkthrough|report|artifact)\b)([a-zA-Z0-9_:-]+)>\s*{[\s\S]*?}\s*<\/\1>/i.test(normalized);

    return !hasExecutionEvidence || /<\/execution_plan>\s*$/i.test(normalized);
};

const needsContinuationAfterTrailingSection = (response: string): boolean => {
    const normalized = response.trim();
    if (!normalized) return false;

    if (/<report\b[\s\S]*?<\/report>\s*$/i.test(normalized)) {
        return false;
    }

    // Exact trailing match (tag is at the very end)
    if (/<\/(?:progress|tasklist|execution_plan|walkthrough)>\s*$/i.test(normalized)) {
        return true;
    }

    // Allow short trailing text (≤ 80 chars) after the last closing tag
    const closingTagPattern = /<\/(?:progress|tasklist|execution_plan|walkthrough)>/gi;
    let lastTagEnd = -1;
    let match: RegExpExecArray | null = null;
    while ((match = closingTagPattern.exec(normalized)) !== null) {
        lastTagEnd = match.index + match[0].length;
    }
    if (lastTagEnd > 0) {
        const afterTag = normalized.slice(lastTagEnd).trim();
        if (afterTag.length > 0 && afterTag.length <= 80) {
            return true;
        }
    }

    return false;
};

const TOOL_REQUIRED_REQUEST_KEYWORDS = /확인|조회|목록|검색|열어|열기|읽어|읽기|실행|생성|만들|삭제|이동|복사|경로|파일|디렉토리|폴더|버전|cpu|uptime|전원|배터리|시간|현재|status|list|count|check|inspect|read|open|run|execute|file|path|version|power|battery|time/i;

const needsContinuationAfterAnalysisOnly = (response: string, userRequest: string): boolean => {
    const normalized = response.trim();
    if (!normalized) return false;

    if (!TOOL_REQUIRED_REQUEST_KEYWORDS.test(userRequest)) {
        return false;
    }

    const hasToolCall =
        /\[TOOL:\s*[a-zA-Z0-9_:-]+\s*(?:{[\s\S]*?})?\s*\]/i.test(normalized)
        || /\[(?:EXECUTE_COMMAND|SEND_KEYS):/i.test(normalized)
        || /(?:>>>|<<<)\s*(?:EXECUTE_COMMAND|SEND_KEYS):/i.test(normalized)
        || /(?:>>>|<<<)\s*[A-Z0-9_:-]+\s*:\s*{[\s\S]*?}\s*<<</i.test(normalized)
        || /<(?!\/?(?:analysis|progress|tasklist|execution_plan|walkthrough|report|artifact)\b)([a-zA-Z0-9_:-]+)>\s*{[\s\S]*?}\s*<\/\1>/i.test(normalized);

    if (hasToolCall) return false;

    const hasCompletionEvidence =
        /<walkthrough\b[\s\S]*?<\/walkthrough>/i.test(normalized)
        || /<report\b[\s\S]*?<\/report>/i.test(normalized)
        || /<artifact\b[\s\S]*?<\/artifact>/i.test(normalized);

    if (hasCompletionEvidence) return false;

    const hasAnalysis =
        /<analysis\b[\s\S]*?<\/analysis>/i.test(normalized)
        || /need to use/i.test(normalized)
        || /I can use/i.test(normalized)
        || /해야 합니다/i.test(normalized);

    return hasAnalysis;
};

const isInteractiveTerminalLaunch = (commandText: string): boolean => {
    const normalized = commandText.trim().toLowerCase();
    if (!normalized) return false;

    return /(^|\s)(nano|pico|vim|vi|nvim|less|more|man|top|htop)(\s|$)/.test(normalized);
};

const detectInteractiveLaunchState = (commandText: string, terminalText: string): 'opened' | 'not_opened' | 'unknown' => {
    const normalized = commandText.trim().toLowerCase();
    const upper = terminalText.toUpperCase();
    const lastLine = terminalText
        .split('\n')
        .map(line => line.trimEnd())
        .filter(line => line.trim().length > 0)
        .slice(-1)[0]
        ?.trim() || '';

    if (/(^|\s)(nano|pico)(\s|$)/.test(normalized)) {
        if (upper.includes('UW PICO') || upper.includes('GNU NANO') || upper.includes('^X EXIT')) return 'opened';
        if (/[%#$]\s*$/.test(lastLine)) return 'not_opened';
        return 'unknown';
    }

    if (/(^|\s)(vim|vi|nvim)(\s|$)/.test(normalized)) {
        if (upper.includes('-- INSERT --') || upper.includes('VIM') || /\bE\d+:/i.test(terminalText)) return 'opened';
        if (/[%#$]\s*$/.test(lastLine)) return 'not_opened';
        return 'unknown';
    }

    if (/(^|\s)(less|more|man)(\s|$)/.test(normalized)) {
        if (upper.includes('(END)') || upper.includes('MANUAL PAGE') || upper.includes('PRESS H FOR HELP OR Q TO QUIT')) return 'opened';
        if (/[%#$]\s*$/.test(lastLine)) return 'not_opened';
        return 'unknown';
    }

    return 'unknown';
};


const ReasoningBox = ({ content, isThinking, durationMs }: { content: string, isThinking: boolean, durationMs?: number }) => {
    const [isCollapsed, setIsCollapsed] = useState(!isThinking);

    useEffect(() => {
        if (isThinking) setIsCollapsed(false);
    }, [isThinking]);

    if (!content && !isThinking) return null;

    return (
        <div className={`reasoning-status ${isCollapsed ? 'collapsed' : ''}`} style={{ background: '#111', border: 'none' }}>
            <div className="reasoning-header" onClick={() => setIsCollapsed(!isCollapsed)} style={{ color: '#888', textTransform: 'none', border: 'none' }}>
                <span style={{ fontSize: '10px' }}>{isCollapsed ? '▶' : '▼'}</span>
                <span>{isThinking ? 'Thinking...' : formatThoughtDuration(durationMs || 0)}</span>
            </div>
            {!isCollapsed && (
                <div className="reasoning-body" style={{ color: '#eee', background: '#000' }}>
                    {content}
                    {isThinking && <span className="typing-cursor">|</span>}
                </div>
            )}
        </div>
    );
};

function App() {
    const terminalContainersRef = useRef<{ [id: string]: HTMLDivElement | null }>({});
    const xtermsRef = useRef<{ [id: string]: Terminal | null }>({});
    const fitAddonsRef = useRef<{ [id: string]: FitAddon | null }>({});
    const fitTimeoutsRef = useRef<number[]>([]);
    const recentTerminalBuffersRef = useRef<Record<string, string>>({});

    const [tabs, setTabs] = useState<Tab[]>([{ id: '1', name: 'Tab 1' }]);
    const [activeTabId, setActiveTabId] = useState('1');
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isMcpDocsOpen, setIsMcpDocsOpen] = useState(false);

    // Settings with persistence
    const [language, setLanguage] = useState<Language>(() => (localStorage.getItem('language') as Language) || 'ko');
    const [apiUrl, setApiUrl] = useState(() => localStorage.getItem('apiUrl') || 'localhost:1234');
    const [apiKey, setApiKey] = useState(() => localStorage.getItem('apiKey') || '');
    const [modelName, setModelName] = useState(() => localStorage.getItem('modelName') || 'qwen/qwen3.5-35b-a3b');
    const [maxTokens, setMaxTokens] = useState(() => Number(localStorage.getItem('maxTokens')) || 10000);
    const [temperature, setTemperature] = useState(() => Number(localStorage.getItem('temperature')) || 0.7);
    const [provider, setProvider] = useState(() => localStorage.getItem('provider') || 'LM Studio');
    const [globalUserPrompt, setGlobalUserPrompt] = useState(() => localStorage.getItem('globalUserPrompt') || '');

    // Terminal Settings with persistence
    const [termFontSize, setTermFontSize] = useState(() => clampTerminalFontSize(Number(localStorage.getItem('termFontSize')) || 12));
    const [termFontFamily, setTermFontFamily] = useState(() => localStorage.getItem('termFontFamily') || '"Cascadia Code", Menlo, Monaco, "Courier New", monospace');
    const [termForeground, setTermForeground] = useState(() => localStorage.getItem('termForeground') || '#c0caf5');
    const [termBackground, setTermBackground] = useState(() => localStorage.getItem('termBackground') || '#000000');

    // Assistant Settings with persistence
    const [chatFontSize, setChatFontSize] = useState(() => clampChatFontSize(Number(localStorage.getItem('chatFontSize')) || 12));
    const [chatFontFamily, setChatFontFamily] = useState(() => {
        const saved = localStorage.getItem('chatFontFamily');
        if (!saved || saved.includes("Inter")) return 'system-ui, -apple-system, sans-serif';
        return saved;
    });
    const [chatWidth, setChatWidth] = useState(() => Number(localStorage.getItem('chatWidth')) || 450);
    const [mcpPort, setMcpPort] = useState(() => Number(localStorage.getItem('mcpPort')) || 4321);
    const [mcpLabel, setMcpLabel] = useState(() => localStorage.getItem('mcpLabel') || 'dinkisstyle-terminal');
    const [maxTokensInput, setMaxTokensInput] = useState(() => String(Number(localStorage.getItem('maxTokens')) || 10000));
    const [mcpPortInput, setMcpPortInput] = useState(() => String(Number(localStorage.getItem('mcpPort')) || 4321));
    const [debugPanelEnabled, setDebugPanelEnabled] = useState(() => localStorage.getItem('debugPanelEnabled') === 'true');
    const [debugPanelTab, setDebugPanelTab] = useState<DebugPanelTab>('context');
    const [debugTrace, setDebugTrace] = useState<DebugTrace>(() => createEmptyDebugTrace());
    const [blockedCommandPatterns, setBlockedCommandPatterns] = useState(() => localStorage.getItem('blockedCommandPatterns') || DEFAULT_BLOCKED_COMMAND_PATTERNS);
    const [approvalCommandPatterns, setApprovalCommandPatterns] = useState(() => localStorage.getItem('approvalCommandPatterns') || DEFAULT_APPROVAL_COMMAND_PATTERNS);
    const isResizing = useRef(false);

    // MCP Settings with persistence
    const [enabledTools, setEnabledTools] = useState<string[]>(() => {
        try {
            const saved = localStorage.getItem('enabledTools');
            return saved ? JSON.parse(saved) : ['search_web', 'read_web_page', 'get_current_time', 'execute_command', 'send_keys', 'read_terminal_tail', 'naver_search', 'namu_wiki'];
        } catch (e) {
            console.error("Error parsing enabledTools", e);
            return ['search_web', 'read_web_page', 'get_current_time', 'execute_command', 'send_keys', 'read_terminal_tail', 'naver_search', 'namu_wiki'];
        }
    });
    const [pendingApproval, setPendingApproval] = useState<PendingCommandApproval | null>(null);
    const textAssistOffProps = {
        autoComplete: 'off',
        autoCorrect: 'off' as const,
        autoCapitalize: 'off' as const,
        spellCheck: false,
    };

    useEffect(() => {
        localStorage.setItem('language', language);
        localStorage.setItem('apiUrl', apiUrl);
        localStorage.setItem('apiKey', apiKey);
        localStorage.setItem('modelName', modelName);
        localStorage.setItem('maxTokens', String(maxTokens));
        localStorage.setItem('temperature', String(temperature));
        localStorage.setItem('provider', provider);
        localStorage.setItem('globalUserPrompt', globalUserPrompt);
        localStorage.setItem('termFontSize', String(termFontSize));
        localStorage.setItem('termFontFamily', termFontFamily);
        localStorage.setItem('termForeground', termForeground);
        localStorage.setItem('termBackground', termBackground);
        localStorage.setItem('chatFontSize', String(chatFontSize));
        localStorage.setItem('chatFontFamily', chatFontFamily);
        localStorage.setItem('chatWidth', String(chatWidth));
        localStorage.setItem('mcpPort', String(mcpPort));
        localStorage.setItem('mcpLabel', mcpLabel);
        localStorage.setItem('blockedCommandPatterns', blockedCommandPatterns);
        localStorage.setItem('approvalCommandPatterns', approvalCommandPatterns);
        localStorage.setItem('enabledTools', JSON.stringify(enabledTools));
        localStorage.setItem('debugPanelEnabled', String(debugPanelEnabled));
    }, [language, apiUrl, apiKey, modelName, maxTokens, temperature, provider, globalUserPrompt, termFontSize, termFontFamily, termForeground, termBackground, chatFontSize, chatFontFamily, chatWidth, mcpPort, mcpLabel, blockedCommandPatterns, approvalCommandPatterns, enabledTools, debugPanelEnabled]);

    const handleSaveSettings = () => {
        const nextMaxTokens = Number.parseInt(maxTokensInput, 10);
        const nextMcpPort = Number.parseInt(mcpPortInput, 10);
        const resolvedMaxTokens = Number.isFinite(nextMaxTokens) && nextMaxTokens > 0 ? nextMaxTokens : maxTokens;
        const resolvedMcpPort = Number.isFinite(nextMcpPort) && nextMcpPort > 0 ? nextMcpPort : mcpPort;

        setMaxTokens(resolvedMaxTokens);
        setMcpPort(resolvedMcpPort);
        setMaxTokensInput(String(resolvedMaxTokens));
        setMcpPortInput(String(resolvedMcpPort));

        UpdateMCPSettings(resolvedMcpPort, mcpLabel, debugPanelEnabled);
        setIsSettingsOpen(false);
        setIsMcpDocsOpen(false);
    };

    useEffect(() => {
        setMaxTokensInput(String(maxTokens));
    }, [maxTokens]);

    useEffect(() => {
        setMcpPortInput(String(mcpPort));
    }, [mcpPort]);

    useEffect(() => {
        UpdateMCPSettings(mcpPort, mcpLabel, debugPanelEnabled).catch((error) => {
            console.error('[MCP] Failed to apply persisted MCP settings on startup:', error);
        });
    }, []);

    useEffect(() => {
        if (!isSettingsOpen) {
            setIsMcpDocsOpen(false);
        }
    }, [isSettingsOpen]);

    useEffect(() => {
        SetActiveTab(activeTabId);
    }, [activeTabId]);

    const [availableTools, setAvailableTools] = useState<any[]>([]);
    
    const t = (key: Parameters<typeof getTranslation>[1]) => getTranslation(language, key);

    const [messages, setMessages] = useState<Message[]>([
        {
            role: 'assistant',
            content: `<analysis>System Initialization</analysis>
<progress title="${t('greetingTitle')}" description="${t('greetingDesc')}">
1. Terminal connected to active tab
2. MCP tools loaded and ready
3. Markdown renderer initialized
</progress>
${t('greeting')}`
        }
    ]);
    const [inputText, setInputText] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const chatEndRef = useRef<HTMLDivElement>(null);
    const [currentThinking, setCurrentThinking] = useState('');
    const [isThinking, setIsThinking] = useState(false);
    const [currentReasoningStartedAt, setCurrentReasoningStartedAt] = useState<number | null>(null);
    const [currentReasoningDurationMs, setCurrentReasoningDurationMs] = useState(0);
    const [llmProgress, setLlmProgress] = useState<LLMProgressState | null>(null);
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const messagesRef = useRef<Message[]>(messages);
    const currentThinkingRef = useRef('');
    const currentReasoningStartedAtRef = useRef<number | null>(null);
    const requestSequenceRef = useRef(0);
    const llmProgressHideTimeoutRef = useRef<number | null>(null);
    const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

    const getNextTabName = (existingTabs: Tab[]): string => {
        const usedNumbers = new Set(
            existingTabs
                .map(tab => {
                    const match = tab.name.match(/^Tab\s+(\d+)$/i);
                    return match ? Number(match[1]) : null;
                })
                .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0)
        );

        let nextNumber = 1;
        while (usedNumbers.has(nextNumber)) {
            nextNumber += 1;
        }

        return `Tab ${nextNumber}`;
    };

    const openNewTab = () => {
        const newId = String(Date.now());
        setTabs(prev => [...prev, { id: newId, name: getNextTabName(prev) }]);
        setActiveTabId(newId);
    };

    const switchToTabIndex = (index: number) => {
        if (index < 0 || index >= tabs.length) return false;
        setActiveTabId(tabs[index].id);
        return true;
    };

    const handleFetchModels = async () => {
        setIsFetchingModels(true);
        try {
            // @ts-ignore
            const models = await window.go.main.App.FetchAvailableModels(apiUrl, apiKey);
            setAvailableModels(models);
            if (models.length === 0) {
                alert("모델 목록은 받아왔지만 비어 있습니다. 서버 URL과 모델 서버 상태를 확인해 주세요.");
            } else if (!models.includes(modelName)) {
                setModelName(models[0]);
            }
        } catch (err) {
            console.error("Failed to fetch models:", err);
            alert("모델 목록을 가져오는데 실패했습니다. URL과 API Key를 확인해 주세요.");
        } finally {
            setIsFetchingModels(false);
        }
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isResizing.current) return;
            const newWidth = window.innerWidth - e.clientX;
            if (newWidth > 300 && newWidth < 800) {
                setChatWidth(newWidth);
            }
        };
        const handleMouseUp = () => {
            isResizing.current = false;
            document.body.style.cursor = 'default';
        };
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        window.addEventListener('open-artifact', (e: any) => {
            alert("Opening artifact: " + e.detail);
        });
        const unlistenNewTab = EventsOn("app:new-tab", () => {
            openNewTab();
        });
        const unlistenSwitchTab = EventsOn("app:switch-tab", (index: number) => {
            switchToTabIndex(Number(index));
        });

        const handleFontZoom = (event: KeyboardEvent) => {
            if (!(event.metaKey || event.ctrlKey)) return;

            const isZoomIn = event.key === '+' || event.key === '=' || event.code === 'NumpadAdd';
            const isZoomOut = event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract';
            if (!isZoomIn && !isZoomOut) return;

            event.preventDefault();
            const delta = isZoomIn ? 1 : -1;
            setTermFontSize(prev => clampTerminalFontSize(prev + delta));
            setChatFontSize(prev => clampChatFontSize(prev + delta));
        };

        const handleAppShortcuts = (event: KeyboardEvent) => {
            const isFullscreenShortcut = event.key === 'F11' || ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f');
            if (isFullscreenShortcut) {
                event.preventDefault();
                void handleToggleFullscreen();
                return;
            }

            const normalizedKeys = [
                event.metaKey ? 'CMD' : '',
                event.ctrlKey ? 'CTRL' : '',
                event.shiftKey ? 'SHIFT' : '',
                event.key,
            ].filter(Boolean);

            if (isAppNewTabShortcut(normalizedKeys)) {
                event.preventDefault();
                openNewTab();
                return;
            }

            if (isAppCloseTabShortcut(normalizedKeys)) {
                event.preventDefault();
                confirmAndCloseActiveTab();
                return;
            }

            const tabIndex = getAppTabSwitchIndex(normalizedKeys);
            if (tabIndex !== null) {
                event.preventDefault();
                switchToTabIndex(tabIndex);
            }
        };

        window.addEventListener('keydown', handleFontZoom);
        window.addEventListener('keydown', handleAppShortcuts);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            window.removeEventListener('open-artifact', (e: any) => { });
            unlistenNewTab();
            unlistenSwitchTab();
            window.removeEventListener('keydown', handleFontZoom);
            window.removeEventListener('keydown', handleAppShortcuts);
            fitTimeoutsRef.current.forEach(timeout => window.clearTimeout(timeout));
        };
    }, [tabs]);

    useEffect(() => {
        const unoffChunk = EventsOn("llm:chunk", (chunk: string) => {
            setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last && last.role === 'assistant') {
                    const newMessages = [...prev];
                    newMessages[newMessages.length - 1] = { ...last, content: last.content + chunk };
                    return newMessages;
                }
                return prev;
            });
        });

        const unoffThinking = EventsOn("llm:thinking", (chunk: string) => {
            beginReasoningTimer();
            setCurrentThinking(prev => prev + chunk);
            setIsThinking(true);
        });

        const unoffProgress = EventsOn("llm:status", (payload: any) => {
            if (!payload?.active) {
                if (llmProgressHideTimeoutRef.current !== null) {
                    window.clearTimeout(llmProgressHideTimeoutRef.current);
                    llmProgressHideTimeoutRef.current = null;
                }
                setLlmProgress(null);
                return;
            }

            const phase: LLMProgressState['phase'] = payload.phase === 'model-load' ? 'model-load' : 'prompt-processing';
            const nextProgress: LLMProgressState = {
                phase,
                label: payload.label || (phase === 'model-load' ? 'Loading Model...' : 'Processing Prompt...'),
                percent: Number(payload.percent || 0),
                active: true,
            };
            setLlmProgress(nextProgress);

            if (nextProgress.percent >= 100) {
                if (llmProgressHideTimeoutRef.current !== null) {
                    window.clearTimeout(llmProgressHideTimeoutRef.current);
                }
                llmProgressHideTimeoutRef.current = window.setTimeout(() => {
                    setLlmProgress(null);
                    llmProgressHideTimeoutRef.current = null;
                }, 700);
            }
        });

        return () => {
            if (llmProgressHideTimeoutRef.current !== null) {
                window.clearTimeout(llmProgressHideTimeoutRef.current);
                llmProgressHideTimeoutRef.current = null;
            }
            unoffChunk();
            unoffThinking();
            unoffProgress();
        };
    }, []);

    const scrollToBottom = () => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    const isTerminalNearBottom = (term: any): boolean => {
        const buffer = term?.buffer?.active;
        if (!buffer || typeof term?.rows !== 'number') return true;

        const viewportY = typeof buffer.viewportY === 'number' ? buffer.viewportY : 0;
        const rows = Math.max(term.rows, 1);
        const bottomViewportY = Math.max(buffer.baseY - Math.max(rows - 1, 0), 0);
        return viewportY >= bottomViewportY - 1;
    };

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    useEffect(() => {
        currentThinkingRef.current = currentThinking;
    }, [currentThinking]);

    useEffect(() => {
        currentReasoningStartedAtRef.current = currentReasoningStartedAt;
    }, [currentReasoningStartedAt]);

    useEffect(() => {
        if (!isThinking || currentReasoningStartedAt === null) return;

        const updateDuration = () => {
            setCurrentReasoningDurationMs(Date.now() - currentReasoningStartedAt);
        };

        updateDuration();
        const timer = window.setInterval(updateDuration, 500);
        return () => window.clearInterval(timer);
    }, [isThinking, currentReasoningStartedAt]);

    const scheduleTerminalFit = (tabId: string) => {
        const runFit = () => {
            const fitAddon = fitAddonsRef.current[tabId];
            const term = xtermsRef.current[tabId];
            if (!fitAddon || !term) return;

            try {
                const shouldKeepBottom = isTerminalNearBottom(term);
                fitAddon.fit();
                if (shouldKeepBottom) {
                    term.scrollToBottom();
                }
                if (term.rows > 0 && term.cols > 0) {
                    ResizeTerminal(tabId, term.cols, term.rows);
                }
            } catch (error) {
                console.warn(`[Terminal] fit failed for tab ${tabId}`, error);
            }
        };

        requestAnimationFrame(runFit);
        [40, 120, 260].forEach(delay => {
            const timeout = window.setTimeout(runFit, delay);
            fitTimeoutsRef.current.push(timeout);
        });
    };

    const beginReasoningTimer = () => {
        if (currentReasoningStartedAtRef.current !== null) return;
        const startedAt = Date.now();
        currentReasoningStartedAtRef.current = startedAt;
        setCurrentReasoningStartedAt(startedAt);
        setCurrentReasoningDurationMs(0);
    };

    const resetReasoningTimer = () => {
        currentReasoningStartedAtRef.current = null;
        setCurrentReasoningStartedAt(null);
        setCurrentReasoningDurationMs(0);
    };

    const finalizeReasoningDuration = () => {
        if (currentReasoningStartedAtRef.current === null) {
            return 0;
        }
        const duration = Math.max(0, Date.now() - currentReasoningStartedAtRef.current);
        setCurrentReasoningDurationMs(duration);
        return duration;
    };

    const updateDebugTrace = (patch: Partial<DebugTrace>) => {
        setDebugTrace(prev => ({
            ...prev,
            ...patch,
            updatedAt: Date.now(),
        }));
    };

    const appendDebugToolExecution = (entry: DebugToolExecution) => {
        setDebugTrace(prev => ({
            ...prev,
            toolExecutions: [...prev.toolExecutions.slice(-11), entry],
            updatedAt: Date.now(),
        }));
    };

    const renderDebugPanelContent = () => {
        const sections: Record<DebugPanelTab, string> = {
            context: debugTrace.screenContext || '(no context captured yet)',
            request: [debugTrace.requestMeta, debugTrace.requestMessages].filter(Boolean).join('\n\n') || '(no request captured yet)',
            response: [debugTrace.rawResponse, debugTrace.parsedToolCall].filter(Boolean).join('\n\n') || '(no response captured yet)',
            tools: debugTrace.toolExecutions.length > 0
                ? safeJsonStringify(debugTrace.toolExecutions)
                : '(no tool executions captured yet)',
            terminal: debugTrace.terminalNotes || '(no terminal diagnostics captured yet)',
        };

        return sections[debugPanelTab];
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, currentThinking]);

    useEffect(() => {
        tabs.forEach(tab => {
            if (xtermsRef.current[tab.id]) return;
            const container = terminalContainersRef.current[tab.id];
            if (!container) return;

            const term = new Terminal({
                cursorBlink: true,
                scrollback: 5000,
                fontSize: termFontSize,
                fontFamily: termFontFamily,
                theme: {
                    background: termBackground,
                    foreground: termForeground,
                    cursor: '#7aa2f7',
                    selectionBackground: '#3b4261',
                }
            });

            const fitAddon = new FitAddon();
            term.loadAddon(fitAddon);
            term.open(container);

            xtermsRef.current[tab.id] = term;
            fitAddonsRef.current[tab.id] = fitAddon;
            scheduleTerminalFit(tab.id);

            term.onData(data => WriteToTerminal(tab.id, data));
            const unoff = EventsOn("terminal:data:" + tab.id, (data: string) => {
                void syncRecentTerminalContextBuffer(tab.id);
                const shouldKeepBottom = isTerminalNearBottom(term);
                term.write(data, () => {
                    if (shouldKeepBottom) {
                        term.scrollToBottom();
                    }
                });
            });
            StartTerminal(tab.id);
            (term as any)._unoff = unoff;
        });

        const handleResize = () => {
            Object.keys(fitAddonsRef.current).forEach(id => scheduleTerminalFit(id));
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [tabs]);

    useEffect(() => {
        Object.values(xtermsRef.current).forEach(term => {
            if (!term) return;
            term.options.fontSize = clampTerminalFontSize(termFontSize);
            term.options.fontFamily = termFontFamily;
            term.options.theme = {
                background: termBackground,
                foreground: termForeground,
                cursor: '#7aa2f7',
                selectionBackground: '#3b4261',
            };
        });
        Object.keys(fitAddonsRef.current).forEach(id => scheduleTerminalFit(id));
    }, [termFontSize, termFontFamily, termBackground, termForeground]);

    useEffect(() => {
        if (activeTabId) {
            scheduleTerminalFit(activeTabId);
            void syncRecentTerminalContextBuffer(activeTabId);
        }
    }, [activeTabId, chatWidth, debugPanelEnabled]);

    useEffect(() => {
        Object.keys(fitAddonsRef.current).forEach(id => scheduleTerminalFit(id));
    }, [debugPanelEnabled]);

    useEffect(() => {
        GetTools().then(setAvailableTools);
    }, []);

    useEffect(() => {
        WindowIsFullscreen()
            .then(setIsFullscreen)
            .catch(() => setIsFullscreen(false));
    }, []);

    const addTab = () => {
        openNewTab();
    };

    const handleToggleFullscreen = async () => {
        try {
            const nextState = !(await WindowIsFullscreen());
            if (nextState) {
                WindowFullscreen();
            } else {
                WindowUnfullscreen();
            }
            setIsFullscreen(nextState);
        } catch (error) {
            console.warn('[Window] Failed to toggle fullscreen:', error);
        }
    };

    const removeTabById = (id: string) => {
        if (tabs.length === 1) return;
        const term = xtermsRef.current[id];
        if (term) {
            (term as any)._unoff?.();
            term.dispose();
        }
        delete xtermsRef.current[id];
        delete fitAddonsRef.current[id];
        delete terminalContainersRef.current[id];
        StopTerminal(id);
        const newTabs = tabs.filter(t => t.id !== id);
        setTabs(newTabs);
        if (activeTabId === id) setActiveTabId(newTabs[newTabs.length - 1].id);
    };

    const removeTab = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        removeTabById(id);
    };

    const confirmAndCloseActiveTab = () => {
        if (tabs.length === 1) return;
        const activeTab = tabs.find(tab => tab.id === activeTabId);
        const shouldClose = window.confirm(t('confirmCloseTab').replace('{name}', activeTab?.name || 'Tab'));
        if (!shouldClose) return;
        removeTabById(activeTabId);
    };

    const getVisibleTerminalText = (): string => {
        const term = xtermsRef.current[activeTabId] as any;
        if (!term?.buffer?.active) return t('terminalUnavailable');

        const buffer = term.buffer.active;
        const preferredStart = typeof buffer.viewportY === 'number'
            ? buffer.viewportY
            : Math.max(0, buffer.baseY - term.rows);
        const start = Math.max(0, preferredStart);
        const end = Math.min(buffer.length - 1, start + Math.max(term.rows - 1, 0));
        const lines: string[] = [];
        for (let i = start; i <= end; i += 1) {
            const line = buffer.getLine(i);
            if (!line) continue;
            lines.push(line.translateToString(true));
        }

        return lines.join('\n') || t('terminalEmpty');
    };

    const syncRecentTerminalContextBuffer = async (tabId: string) => {
        if (!tabId) return t('terminalEmpty');

        try {
            const buffer = await GetRecentTerminalBuffer(tabId, TERMINAL_CONTEXT_CHAR_LIMIT);
            const normalized = compactTerminalContext(buffer || '');
            recentTerminalBuffersRef.current[tabId] = normalized || t('terminalEmpty');
            return recentTerminalBuffersRef.current[tabId];
        } catch {
            const fallback = recentTerminalBuffersRef.current[tabId] || t('terminalEmpty');
            recentTerminalBuffersRef.current[tabId] = fallback;
            return fallback;
        }
    };

    const getRecentTerminalContextBuffer = (tabId: string): string => (
        recentTerminalBuffersRef.current[tabId] || t('terminalEmpty')
    );

    const shouldIncludeScreenContext = (history: Message[]): boolean => {
        return history.length > 0 && shouldAttachScreenContext(history);
    };

    const buildScreenContext = (history: Message[]): string => {
        const activeTab = tabs.find(tab => tab.id === activeTabId);
        const visibleChat = buildCompactVisibleChat(history);

        return [
            `TAB: ${activeTab?.name || activeTabId}`,
            `WIDTH: ${chatWidth}px`,
            'TERMINAL:',
            clampTextFromEnd(getRecentTerminalContextBuffer(activeTabId), 700),
            'CHAT:',
            visibleChat || t('chatEmpty'),
        ].join('\n');
    };

    const parseSafetyPatterns = (value: string): string[] => (
        value
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
    );

    const splitCommandSegments = (command: string): string[] => (
        command
            .split(/&&|\|\||;|\|/g)
            .map(segment => segment.trim())
            .filter(Boolean)
    );

    const tokenizeCommandSegment = (segment: string): string[] => (
        segment
            .replace(/["'`]/g, ' ')
            .trim()
            .split(/\s+/)
            .filter(Boolean)
    );

    const matchesCommandPattern = (command: string, pattern: string): boolean => {
        const patternTokens = tokenizeCommandSegment(pattern);
        if (patternTokens.length === 0) return false;

        return splitCommandSegments(command).some(segment => {
            const segmentTokens = tokenizeCommandSegment(segment);
            if (segmentTokens.length < patternTokens.length) return false;

            for (let i = 0; i < patternTokens.length; i += 1) {
                const expected = patternTokens[i].toLowerCase();
                const actual = (segmentTokens[i] || '').toLowerCase();

                if (expected.endsWith('=')) {
                    if (!actual.startsWith(expected)) return false;
                    continue;
                }

                if (actual !== expected) return false;
            }

            return true;
        });
    };

    const classifyCommand = (command: string): { status: 'allow' | 'blocked' | 'approval'; reason?: string } => {
        const blockedMatch = parseSafetyPatterns(blockedCommandPatterns).find(pattern => matchesCommandPattern(command, pattern));
        if (blockedMatch) {
            return {
                status: 'blocked',
                reason: t('blockedReason').replace('{rule}', blockedMatch),
            };
        }

        const approvalMatch = parseSafetyPatterns(approvalCommandPatterns).find(pattern => matchesCommandPattern(command, pattern));
        if (approvalMatch) {
            return {
                status: 'approval',
                reason: t('approvalReason').replace('{rule}', approvalMatch),
            };
        }

        return { status: 'allow' };
    };

    const buildLLMMessages = (
        history: Message[],
        baseSystemPrompt: string,
        options?: { includeScreenContext?: boolean }
    ) => {
        const includeScreenContext = options?.includeScreenContext ?? false;
        const taskMemory = buildTaskMemory(history);
        const compactHistory = buildCompactHistory(history);
        const systemSections = [baseSystemPrompt, `TASK_MEMORY:\n${renderTaskMemory(taskMemory)}`];

        if (includeScreenContext) {
            systemSections.push(`SCREEN_CONTEXT:\n${buildScreenContext(history)}`);
        }

        return [{
            role: 'system',
            content: systemSections.join('\n\n'),
        }, ...compactHistory];
    };

    const summarizeToolResultForHistory = (toolName: string, result: string): string => {
        const trimmed = result.trim();
        if (!trimmed) return '(empty result)';

        switch (toolName) {
            case 'execute_command':
                return clampText(trimmed, 160);
            case 'send_keys':
                return clampText(trimmed, 160);
            case 'read_terminal_tail':
                return `[terminal tail]\n${clampText(trimmed, 700)}`;
            case 'search_web':
            case 'read_web_page':
            case 'naver_search':
            case 'namu_wiki':
                return clampText(trimmed, 900);
            default:
                return clampText(trimmed, 400);
        }
    };

    const normalizeCommandForTerminal = (command: string): string => {
        let normalized = command.trim();
        if (!normalized) return normalized;

        if (normalized.includes('<<') && normalized.includes('\\n') && !normalized.includes('\n')) {
            normalized = normalized.replace(/\\n/g, '\n');
        }

        // LM responses sometimes emit cmd-style escaped quotes for native Windows commands.
        // PowerShell expects plain quotes here and otherwise can fall into continuation
        // prompts or pass malformed arguments to native executables such as findstr.
        if (window.navigator.platform.toLowerCase().includes('win') && normalized.includes('\\"')) {
            normalized = normalized.replace(/\\"/g, '"');
        }

        return normalized;
    };

    const executeCommandLocally = async (commandText: string): Promise<string> => {
        const normalized = normalizeCommandForTerminal(commandText);
        if (!normalized) {
            throw new Error('command cannot be empty');
        }

        await WriteToTerminal(activeTabId, `${normalized}\r`);
        return `Sent to terminal: ${normalized}`;
    };

    const fetchLLMFollowUpWithTimeout = async (
        llmMessages: any[],
        fallbackResponse: string,
        contextLabel: string,
    ): Promise<string> => {
        let timeoutHandle: number | null = null;
        let timedOut = false;

        try {
            const response = await Promise.race([
                FetchLLMResponse(apiUrl, apiKey, modelName, maxTokens, temperature, provider, true, llmMessages),
                new Promise<string>((resolve) => {
                    timeoutHandle = window.setTimeout(() => {
                        timedOut = true;
                        void StopLLMResponse();
                        resolve(fallbackResponse);
                    }, FOLLOW_UP_LLM_TIMEOUT_MS);
                }),
            ]);

            updateDebugTrace(timedOut
                ? {
                    rawResponse: maskSensitiveText(response, apiKey),
                    terminalNotes: `${contextLabel}\nFollow-up timed out after ${FOLLOW_UP_LLM_TIMEOUT_MS}ms.\nFallback: ${fallbackResponse}`,
                }
                : {
                    rawResponse: maskSensitiveText(response, apiKey),
                });
            return response;
        } finally {
            if (timeoutHandle !== null) {
                window.clearTimeout(timeoutHandle);
            }
        }
    };

    const continueAfterToolExecution = async (
        toolName: string,
        toolArgs: string,
        result: string,
        historyToSend: Message[],
        baseSystemPrompt: string,
        responseSansCommand: string,
    ) => {
        appendToolResultToHistory(historyToSend, toolName, toolArgs, result);
        await syncRecentTerminalContextBuffer(activeTabId);

        let nextResponse = '';
        if (responseSansCommand) {
            nextResponse = stripToolCallMarkup(responseSansCommand);
        }

        const llmMessages = buildLLMMessages(historyToSend, baseSystemPrompt, { includeScreenContext: false });
        updateDebugTrace({
            requestMeta: maskSensitiveText([
                `Provider: ${provider}`,
                `Model: ${modelName}`,
                `MaxTokens: ${maxTokens}`,
                `Temperature: ${temperature}`,
                `Context Source: continueAfterToolExecution`,
            ].join('\n'), apiKey),
            requestMessages: maskSensitiveText(safeJsonStringify(llmMessages), apiKey),
            terminalNotes: `Continuation after ${toolName}\nResult summary:\n${result}`,
        });
        nextResponse = await fetchLLMFollowUpWithTimeout(
            llmMessages,
            toolName === 'execute_command'
                ? t('followUpDelayed')
                : t('toolFollowUpDelayed').replace('{tool}', toolName),
            `continueAfterToolExecution:${toolName}`,
        );
        return nextResponse;
    };

    const appendToolResultToHistory = (
        history: Message[],
        toolName: string,
        toolArgs: string,
        result: string,
    ) => {
        const toolRole: 'tool' | 'user' = (provider === 'OpenAI') ? 'tool' : 'user';
        const summarizedResult = summarizeToolResultForHistory(toolName, result);
        const toolContent = (toolRole === 'user') ? `[Tool Response from ${toolName}]: ${summarizedResult}` : summarizedResult;
        const toolResultMsg: Message = { role: toolRole, content: toolContent, name: toolName };

        history.push({ role: 'assistant', content: `[TOOL: ${toolName} ${toolArgs}]` });
        history.push(toolResultMsg);
    };

    const getLatestUserRequest = (history: Message[]): string => {
        for (let index = history.length - 1; index >= 0; index -= 1) {
            const message = history[index];
            if (message.role === 'user' && message.content?.trim() && !isSyntheticToolResponseContent(message.content)) {
                return message.content.trim();
            }
        }
        return '';
    };

    const getRecentMeaningfulTerminalLines = (terminalText: string, count = 8): string[] => {
        const lines = terminalText
            .split('\n')
            .map(line => line.trimEnd())
            .filter(line => line.trim().length > 0);

        return lines.slice(-count);
    };


    const looksLikeShellPromptLine = (line: string): boolean => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        if (/HEREDOC>\s*$/i.test(trimmed)) return false;
        if (/UW PICO|GNU NANO|\^X EXIT|\(END\)|MANUAL PAGE/i.test(trimmed)) return false;

        return /[%#$]\s*$/.test(trimmed)
            || /^[^ \n]+@[^ \n]+.*[%#$]\s*$/.test(trimmed)
            || /(?:^|\/)[^/\n]+\s[%#$]\s*$/.test(trimmed)
            || /^PS [^\r\n>]+>\s*$/.test(trimmed)
            || /^[A-Za-z]:\\.*>\s*$/.test(trimmed);
    };

    const hasRecoveredShellPrompt = (terminalText: string): boolean => {
        return getRecentMeaningfulTerminalLines(terminalText, 5).some(looksLikeShellPromptLine);
    };

    const detectTerminalBlockerState = (terminalText: string): string | null => {
        if (hasRecoveredShellPrompt(terminalText)) {
            return null;
        }

        const recentLines = getRecentMeaningfulTerminalLines(terminalText, 12);
        const recentUpper = recentLines.join('\n').toUpperCase();
        const lastMeaningfulLine = recentLines.length > 0 ? recentLines[recentLines.length - 1].trim() : '';

        if (recentUpper.includes('HEREDOC>')) {
            return t('heredocPending');
        }

        if (lastMeaningfulLine === '>>') {
            return 'PowerShell is waiting for more input at the `>>` continuation prompt. This usually means the command has an unmatched quote, parenthesis, or other incomplete syntax.';
        }

        if (recentUpper.includes('UW PICO') || recentUpper.includes('GNU NANO') || recentUpper.includes('^X EXIT')) {
            return t('editorOpen');
        }

        if (recentUpper.includes('(END)') || recentUpper.includes('MANUAL PAGE')) {
            return t('pagerOpen');
        }

        return null;
    };

    const summarizeTerminalTail = async (
        userRequest: string,
        commandText: string,
        terminalTail: string,
        historyToSend: Message[],
        baseSystemPrompt: string,
    ) => {
        const analysisPrompt = `${baseSystemPrompt}
5. TERMINAL FOLLOW-UP: You will receive the user's latest request, the terminal command that was run for that request, and the terminal output that appeared after it. Answer the user's request directly using the terminal result, not by merely describing the command. If the request asks for a fact like CPU, version, file name, or status, state that fact plainly in the first sentence.
6. TERMINAL FOLLOW-UP FORMAT: If the request has been satisfied, answer it directly in natural Korean and mention the supporting evidence briefly. If it failed, start with "${t('workFailed')}" and explain why. If the result is still inconclusive, start with "${t('workIncomplete')}" and explain what is missing. If terminal output alone is inconclusive, use SCREEN_CONTEXT to check whether the prompt returned or the visible app state suggests completion. Do not emit tool calls in this follow-up summary.
7. If COMPLEX TASK MODE applies, preserve the same runbook style and end with a <report> block instead of a plain summary when possible.`;

        const terminalContext: Message[] = [
            ...historyToSend,
            {
                role: 'user',
                content: `[Latest user request]\n${userRequest || '(missing)'}\n\n[Executed command]\n${commandText}\n\n[Terminal output after the command]\n${terminalTail}`,
            },
        ];

        await syncRecentTerminalContextBuffer(activeTabId);
        const llmMessages = buildLLMMessages(terminalContext, analysisPrompt, { includeScreenContext: true });
        updateDebugTrace({
            requestMeta: maskSensitiveText([
                `Provider: ${provider}`,
                `Model: ${modelName}`,
                `MaxTokens: ${maxTokens}`,
                `Temperature: ${temperature}`,
                `Context Source: summarizeTerminalTail`,
            ].join('\n'), apiKey),
            requestMessages: maskSensitiveText(safeJsonStringify(llmMessages), apiKey),
            terminalNotes: `Terminal follow-up\nCommand: ${commandText}\n\nTail:\n${terminalTail}`,
        });
        return fetchLLMFollowUpWithTimeout(
            llmMessages,
            t('cmdFollowUpDelayed').replace('{cmd}', commandText),
            `summarizeTerminalTail:${commandText}`,
        );
    };

    const callToolWithClientTimeout = async (
        toolName: string,
        toolArgs: string,
        fallbackResult?: string,
    ): Promise<{ result: string; timedOut: boolean }> => {
        if (toolName === 'execute_command') {
            const parsedArgs = JSON.parse(toolArgs);
            return {
                result: await executeCommandLocally(parsedArgs.command),
                timedOut: false,
            };
        }

        const timeoutMs = (toolName === 'send_keys')
            ? 2500
            : toolName === 'read_terminal_tail'
                ? 1800
                : 8000;

        let timeoutHandle: number | null = null;
        try {
            const parsedArgs = toolArgs.trim() ? JSON.parse(toolArgs) : {};
            const result = await Promise.race([
                (toolName === 'send_keys'
                        ? (async () => handleAppLevelSendKeys(parsedArgs.keys) ?? CallTool(toolName, toolArgs))()
                        : CallTool(toolName, toolArgs)
                ),
                new Promise<string>((resolve) => {
                    timeoutHandle = window.setTimeout(() => {
                        if (fallbackResult) {
                            resolve(fallbackResult);
                        } else if (toolName === 'send_keys') {
                            resolve('Keys sent to terminal (client timeout while waiting for MCP acknowledgement).');
                        } else if (toolName === 'read_terminal_tail') {
                            resolve('(terminal tail unavailable: client timeout while waiting for MCP acknowledgement)');
                        } else {
                            resolve('Tool completed, but the client timed out while waiting for the result.');
                        }
                    }, timeoutMs);
                }),
            ]);

            return {
                result,
                timedOut: result.includes('client timeout while waiting for MCP acknowledgement'),
            };
        } finally {
            if (timeoutHandle !== null) {
                window.clearTimeout(timeoutHandle);
            }
        }
    };

    const shouldContinueAfterToolExecution = (toolName: string) => {
        return toolName !== 'execute_command' && toolName !== 'send_keys';
    };

    const buildTerminalToolSummary = (toolName: string, commandText: string, responseSansCommand: string) => {
        const cleaned = stripToolCallMarkup(responseSansCommand);
        if (toolName === 'execute_command') {
            if (isInteractiveTerminalLaunch(commandText)) {
                return t('interactiveLaunched').replace('{cmd}', commandText);
            }
            return t('cmdSentToTerminal').replace('{cmd}', commandText);
        }

        if (toolName === 'send_keys') {
            return t('keysSent');
        }

        if (cleaned) {
            return cleaned;
        }

        return t('toolExecuted').replace('{tool}', toolName);
    };

    const inspectTerminalIfNeeded = async (
        toolName: string,
        commandText: string,
        historyToSend: Message[],
        baseSystemPrompt: string,
        responseSansCommand: string,
    ) => {
        if (toolName !== 'execute_command' && toolName !== 'send_keys') {
            return buildTerminalToolSummary(toolName, commandText, responseSansCommand);
        }

        if (toolName === 'execute_command' && !shouldInspectTerminalAfterCommand(commandText)) {
            return buildTerminalToolSummary(toolName, commandText, responseSansCommand);
        }

        const tailArgs = JSON.stringify({ lines: 60, maxWaitMs: 2500, idleMs: 900 });
        const { result: tail } = await callToolWithClientTimeout(
            'read_terminal_tail',
            tailArgs,
            '(terminal tail unavailable: client timeout while waiting for MCP acknowledgement)',
        );
        const visibleTerminal = getVisibleTerminalText();
        const combinedTerminal = `${visibleTerminal}\n${tail}`;
        const promptRecovered = hasRecoveredShellPrompt(visibleTerminal) || hasRecoveredShellPrompt(tail);

        if (toolName === 'execute_command' && isInteractiveTerminalLaunch(commandText)) {
            const interactiveState = detectInteractiveLaunchState(commandText, combinedTerminal);
            if (interactiveState === 'opened') {
                return buildTerminalToolSummary(toolName, commandText, responseSansCommand);
            }
            if (interactiveState === 'not_opened') {
                return `작업이 실패했습니다. \`${commandText}\` 실행 후에도 인터랙티브 프로그램이 열린 흔적이 보이지 않고 쉘 프롬프트로 돌아와 있습니다.`;
            }
        }

        if (toolName === 'send_keys' && promptRecovered) {
            return buildTerminalToolSummary(toolName, commandText, responseSansCommand);
        }

        const blocker = detectTerminalBlockerState(combinedTerminal);
        if (blocker) {
            return `작업이 아직 진행 중이거나 완료 여부가 불분명합니다. ${blocker}`;
        }

        if (tail.includes('terminal tail unavailable')) {
            const visibleOnly = visibleTerminal.trim();
            if (!visibleOnly || visibleOnly === t('terminalEmpty') || visibleOnly === t('terminalUnavailable')) {
                return buildTerminalToolSummary(toolName, commandText, responseSansCommand);
            }
            return summarizeTerminalTail(getLatestUserRequest(historyToSend), commandText, visibleOnly, [...historyToSend], baseSystemPrompt);
        }

        const terminalSummarySource = tail.trim() === '(no recent terminal output)'
            ? combinedTerminal
            : tail;

        return summarizeTerminalTail(getLatestUserRequest(historyToSend), commandText, terminalSummarySource, [...historyToSend], baseSystemPrompt);
    };

    const ensureAssistantPlaceholder = () => {
        setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
                return prev;
            }
            const next: Message[] = [...prev, { role: 'assistant', content: '', reasoning: '' }];
            messagesRef.current = next;
            return next;
        });
    };

    const sanitizeHistoryForNewTurn = (history: Message[]): Message[] => {
        const cleaned = [...history];
        while (cleaned.length > 0) {
            const last = cleaned[cleaned.length - 1];
            if (last.role === 'assistant' && !last.content.trim() && !(last.reasoning || '').trim()) {
                cleaned.pop();
                continue;
            }
            break;
        }
        return cleaned;
    };

    const extractHeredocTerminator = (terminalText: string): string | null => {
        const matches = [...terminalText.matchAll(/<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/g)];
        if (matches.length === 0) return null;
        const last = matches[matches.length - 1];
        return last?.[1] || null;
    };

    const normalizeSendKeysForTerminal = (keys: string[]): { keys: string[]; reason?: string } => {
        const normalized = normalizeShortcutTokens(keys);
        const terminalText = getVisibleTerminalText();
        const upperTerminal = terminalText.toUpperCase();
        const looksLikeNano = upperTerminal.includes('UW PICO') || upperTerminal.includes('GNU NANO') || upperTerminal.includes('^X EXIT');
        const looksLikeVim = upperTerminal.includes('-- INSERT --')
            || upperTerminal.includes('-- NORMAL --')
            || upperTerminal.includes('~')
            || upperTerminal.includes(' E486:')
            || upperTerminal.includes('VIM');
        const looksLikePager = upperTerminal.includes('MANUAL PAGE')
            || upperTerminal.includes('(END)')
            || upperTerminal.includes('LINES ')
            || upperTerminal.includes('PRESS H FOR HELP OR Q TO QUIT');
        const looksLikeHeredoc = upperTerminal.includes('HEREDOC>');
        const heredocTerminator = looksLikeHeredoc ? extractHeredocTerminator(terminalText) : null;
        const looksLikeVimQuitAttempt = normalized.some(token => token.includes(':Q')) || normalized.includes('ESC');
        const asksForInterrupt = normalized.includes('CTRL_C');
        const asksForNanoExit = normalized.includes('CTRL_X');
        const asksForPagerQuit = normalized.includes('Q');

        if (looksLikeNano && (looksLikeVimQuitAttempt || asksForInterrupt) && !asksForNanoExit) {
            return {
                keys: ['CTRL_X'],
                reason: 'Detected nano/pico on screen, so remapped the quit sequence to CTRL_X.',
            };
        }

        if (looksLikeVim && asksForNanoExit) {
            return {
                keys: ['ESC', ':q!', 'ENTER'],
                reason: 'Detected vim-style editor on screen, so remapped CTRL_X to ESC, :q!, ENTER.',
            };
        }

        if (looksLikePager && (looksLikeVimQuitAttempt || asksForInterrupt || asksForNanoExit) && !asksForPagerQuit) {
            return {
                keys: ['q'],
                reason: 'Detected pager/help view on screen, so remapped the quit sequence to q.',
            };
        }

        if (looksLikeHeredoc && heredocTerminator && (looksLikeVimQuitAttempt || asksForInterrupt || asksForNanoExit)) {
            return {
                keys: [heredocTerminator, 'ENTER'],
                reason: `Detected heredoc prompt on screen, so remapped the quit sequence to ${heredocTerminator} + ENTER.`,
            };
        }

        return { keys };
    };

    const handleAppLevelSendKeys = (keys: string[]): string | null => {
        if (isAppNewTabShortcut(keys)) {
            openNewTab();
            return 'Opened a new app tab via shortcut.';
        }

        const tabIndex = getAppTabSwitchIndex(keys);
        if (tabIndex !== null) {
            if (switchToTabIndex(tabIndex)) {
                return `Switched to app tab ${tabIndex + 1} via shortcut.`;
            }
            return `Tab ${tabIndex + 1} does not exist.`;
        }

        return null;
    };

    const handleCommandApprovalDecision = async (approved: boolean) => {
        if (!pendingApproval) return;

        const request = pendingApproval;
        setPendingApproval(null);

        if (!approved) {
            setMessages(prev => prev.map(message => (
                message.commandRequest?.status === 'approval' && message.commandRequest.command === request.command
                    ? {
                        ...message,
                        role: 'system',
                        commandRequest: undefined,
                        content: `${t('cmdCanceled')}\n\nCommand: \`${request.command}\``,
                    }
                    : message
            )));
            return;
        }

        setMessages(prev => prev.map(message => (
            message.commandRequest?.status === 'approval' && message.commandRequest.command === request.command
                ? {
                    ...message,
                    commandRequest: undefined,
                    content: `${t('cmdApproved')}\n\nCommand: \`${request.command}\``,
                }
                : message
        )));

        setIsLoading(true);
        setIsThinking(false);
        setCurrentThinking('');
        resetReasoningTimer();

        try {
            const { result, timedOut } = await callToolWithClientTimeout(request.toolName, request.toolArgs);
            setMessages(prev => [...prev, {
                role: 'tool',
                name: request.toolName,
                content: `Command: \`${request.command}\`${timedOut ? `\n\nNote: ${t('mcpTimeout')}` : ''}\n\nStatus: ${result}`
            }]);

            let response = buildTerminalToolSummary('execute_command', request.command, request.responseSansCommand);
            if (shouldContinueAfterToolExecution(request.toolName)) {
                ensureAssistantPlaceholder();
                setIsThinking(true);
                response = await continueAfterToolExecution(
                    request.toolName,
                    request.toolArgs,
                    result,
                    [...request.historyToSend],
                    request.baseSystemPrompt,
                    request.responseSansCommand,
                );
                setIsThinking(false);
            } else {
                ensureAssistantPlaceholder();
                setIsThinking(true);
                response = await inspectTerminalIfNeeded(
                    request.toolName,
                    request.command,
                    [...request.historyToSend],
                    request.baseSystemPrompt,
                    request.responseSansCommand,
                );
                setIsThinking(false);
            }

            const reasoningDurationMs = finalizeReasoningDuration();
            setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') {
                    last.content = response || t('cmdDoneNoResponse');
                    last.reasoning = currentThinking;
                    last.reasoningDurationMs = reasoningDurationMs;
                    return updated;
                }
                return [...updated, { role: 'assistant', content: response || t('cmdDoneNoResponse'), reasoning: currentThinking }];
            });
        } catch (error: any) {
            setMessages(prev => [...prev, { role: 'system', content: `❌ ${t('approvedCmdFailed')} ${error.message || error}` }]);
        } finally {
            setIsLoading(false);
            setIsThinking(false);
            resetReasoningTimer();
        }
    };

    const sendMessage = async () => {
        const trimmedInput = inputText.trim();
        if (!trimmedInput) return;

        const requestId = ++requestSequenceRef.current;
        const isCurrentRequest = () => requestSequenceRef.current === requestId;

        if (isLoading) {
            await StopLLMResponse();
            if (!isCurrentRequest()) return;
        }

        console.log("Sending message...", trimmedInput);
        const userMessage: Message = { role: 'user', content: trimmedInput };
        const baseHistory = sanitizeHistoryForNewTurn(messagesRef.current);
        const newMessages = [...baseHistory, userMessage];
        setMessages(newMessages);
        messagesRef.current = newMessages;
        setInputText('');
        setIsLoading(true);
        setCurrentThinking('');
        currentThinkingRef.current = '';
        setIsThinking(false);
        resetReasoningTimer();
        setLlmProgress({
            phase: 'prompt-processing',
            label: 'Processing Prompt...',
            percent: 0,
            active: true,
        });

        try {
            const activeTools = availableTools.filter(t => enabledTools.includes(t.name));
            console.log(`[LLM] Initiating request to ${apiUrl} with ${activeTools.length} tools enabled.`);
            console.log(`[LLM] Model: ${modelName}, Provider: ${provider}`);
            const complexRequest = shouldUseComplexTaskMode(trimmedInput);
            const availableToolsSection = renderAvailableToolsForPrompt(activeTools);
            const trimmedGlobalUserPrompt = globalUserPrompt.trim();
            const globalUserPromptSection = trimmedGlobalUserPrompt
                ? `

5. GLOBAL USER PROMPT:
Treat this as persistent user preference/context unless it conflicts with safety, exact tool syntax, or the current request.
[BEGIN_GLOBAL_USER_PROMPT]
${trimmedGlobalUserPrompt}
[END_GLOBAL_USER_PROMPT]`
                : '';

            const baseSystemPrompt = `You are ${mcpLabel}, a professional AI engineer. 
1. Keep answers compact for a narrow side chat. Use <analysis>, <progress>, and <artifact> only when helpful.
2. SCREEN_CONTEXT is only for visible UI/terminal/chat state. Do not use it as proof for files, paths, counts, command output, or other verifiable system facts when tools can check them.
3. Tool syntax is strict:
   - Terminal command: >>> EXECUTE_COMMAND: "YOUR_COMMAND" <<<
   - Terminal keys: >>> SEND_KEYS: ["ESC", ":q!", "ENTER"] <<<
   - Other tools: [TOOL: tool_name {"arg":"value"}]
   Use only listed tools. Never invent file-edit tools.
4. Use tools for terminal actions, system checks, files/paths, command results, latest web info, or page verification.
5. Judge requests by meaning, not keywords, across all user languages.
6. If terminal control is stuck in an interactive program, recover with CTRL_C on macOS. If OS is Windows, use PowerShell syntax only.
7. When the user asks for current events, recent facts, or web verification, prefer search_web instead of answering from memory when that tool is available.${buildTaskWorkflowPrompt(complexRequest)}
Current OS: ${window.navigator.platform}
Complex Request Mode: ${complexRequest ? 'enabled' : 'disabled'}

${availableToolsSection}${globalUserPromptSection}`;

            const historyToSend = newMessages.filter((msg, idx) => {
                if (idx === 0 && msg.role === 'assistant') return false;
                return true;
            });
            const loopHistory = [...historyToSend];

            await syncRecentTerminalContextBuffer(activeTabId);
            const initialScreenContext = shouldIncludeScreenContext(loopHistory) ? buildScreenContext(loopHistory) : '(screen context disabled)';
            let currentMessages: any[] = buildLLMMessages(loopHistory, baseSystemPrompt, {
                includeScreenContext: shouldIncludeScreenContext(loopHistory),
            });
            updateDebugTrace({
                screenContext: maskSensitiveText(initialScreenContext, apiKey),
                requestMeta: maskSensitiveText([
                    `Provider: ${provider}`,
                    `Model: ${modelName}`,
                    `MaxTokens: ${maxTokens}`,
                    `Temperature: ${temperature}`,
                    `Context Source: sendMessage`,
                    `Messages: ${currentMessages.length}`,
                ].join('\n'), apiKey),
                requestMessages: maskSensitiveText(safeJsonStringify(currentMessages), apiKey),
                rawResponse: '',
                parsedToolCall: '',
                toolExecutions: [],
                terminalNotes: '',
            });
            console.log(`[LLM] Sending ${currentMessages.length} messages (screen context: ${shouldIncludeScreenContext(loopHistory) ? 'on' : 'off'})`);
            let response = '';
            let commandIntercepted = false;
            setCurrentThinking('');
            currentThinkingRef.current = '';
            setIsThinking(true);
            resetReasoningTimer();

            // Initialize assistant message for streaming
            setMessages(prev => {
                const next: Message[] = [...prev, { role: 'assistant', content: '', reasoning: '' }];
                messagesRef.current = next;
                return next;
            });

            try {
                // Call StopLLMResponse safely
                if ((window as any).go?.main?.App?.StopLLMResponse) {
                    await (window as any).go.main.App.StopLLMResponse();
                    if (!isCurrentRequest()) return;
                }

                response = await FetchLLMResponse(apiUrl, apiKey, modelName, maxTokens, temperature, provider, true, currentMessages);
                updateDebugTrace({
                    rawResponse: maskSensitiveText(response, apiKey),
                });
                if (!isCurrentRequest()) return;
            } catch (err) {
                if (!isCurrentRequest()) return;
                throw err;
            } finally {
                if (isCurrentRequest()) {
                    setIsThinking(false);
                }
            }

            if (!isCurrentRequest()) return;
            for (let continuationAttempt = 0; continuationAttempt < 3; continuationAttempt++) {
                if (
                    !needsContinuationAfterPlan(response)
                    && !needsContinuationAfterTrailingSection(response)
                    && !shouldContinueAfterActionlessAnalysis(response, trimmedInput)
                ) {
                    break;
                }
                ensureAssistantPlaceholder();
                setCurrentThinking('');
                currentThinkingRef.current = '';
                setIsThinking(true);
                const continuationHistory = [
                    ...loopHistory,
                    { role: 'assistant' as const, content: response },
                    {
                        role: 'user' as const,
                        content: needsContinuationAfterPlan(response)
                            ? '[App Notice] The previous reply stopped after an Execution Plan and did not actually carry out the task yet. Continue from that plan now and perform the next concrete action instead of restating the plan.'
                            : needsContinuationAfterTrailingSection(response)
                                ? '[App Notice] The previous reply ended on a progress-like section and appears incomplete. Continue from the last section now and perform the next concrete action or finish the report instead of repeating prior sections.'
                                : '[App Notice] The previous reply only analyzed the request and did not actually perform the next action yet. Continue now by calling the appropriate tool or terminal command instead of repeating the analysis.',
                    },
                ];
                await syncRecentTerminalContextBuffer(activeTabId);
                updateDebugTrace({
                    screenContext: maskSensitiveText(buildScreenContext(continuationHistory), apiKey),
                    requestMeta: maskSensitiveText([
                        `Provider: ${provider}`,
                        `Model: ${modelName}`,
                        `MaxTokens: ${maxTokens}`,
                        `Temperature: ${temperature}`,
                        `Context Source: continuation (attempt ${continuationAttempt + 1})`,
                    ].join('\n'), apiKey),
                    requestMessages: maskSensitiveText(safeJsonStringify(buildLLMMessages(continuationHistory, baseSystemPrompt, {
                        includeScreenContext: shouldIncludeScreenContext(continuationHistory),
                    })), apiKey),
                });
                response = await FetchLLMResponse(
                    apiUrl,
                    apiKey,
                    modelName,
                    maxTokens,
                    temperature,
                    provider,
                    true,
                    buildLLMMessages(continuationHistory, baseSystemPrompt, {
                        includeScreenContext: shouldIncludeScreenContext(continuationHistory),
                    }),
                );
                updateDebugTrace({
                    rawResponse: maskSensitiveText(response, apiKey),
                });
                if (!isCurrentRequest()) return;
                setIsThinking(false);
            }

            let toolLoopCount = 0;
            while (true) {
                if (!isCurrentRequest()) return;
                toolLoopCount += 1;
                if (toolLoopCount > 8) {
                    response = `${response ? `${response}\n\n` : ''}${t('loopLimitReached')}`;
                    break;
                }

                const parsedToolCall = parseToolCallFromResponse(response);
                updateDebugTrace({
                    parsedToolCall: parsedToolCall ? maskSensitiveText(safeJsonStringify(parsedToolCall), apiKey) : '(no tool call parsed)',
                });
                if (parsedToolCall) {
                    const { raw, toolName, commandText, parsedKeys, toolArgs } = parsedToolCall;
                    const normalizedSendKeys = toolName === 'send_keys'
                        ? normalizeSendKeysForTerminal(parsedKeys)
                        : null;
                    const effectiveParsedKeys = normalizedSendKeys?.keys || parsedKeys;
                    const effectiveCommandText = toolName === 'send_keys'
                        ? JSON.stringify(effectiveParsedKeys)
                        : commandText;
                    const effectiveToolArgs = toolName === 'send_keys'
                        ? JSON.stringify({ keys: effectiveParsedKeys })
                        : toolArgs;
                    const missingRequiredToolArgs = (
                        (toolName === 'execute_command' || toolName === 'send_keys')
                        && !effectiveToolArgs.trim()
                    );
                    const commandPolicy = classifyCommand(commandText);
                    const windowsCmdSyntaxError = toolName === 'execute_command' && window.navigator.platform.toLowerCase().includes('win')
                        ? detectWindowsPowerShellSyntaxIssue(commandText)
                        : null;
                    const toolIsAvailable = activeTools.some(tool => tool.name === toolName);

                    // Filter out the tool call from the response to prevent loops and show only final text
                    response = stripToolCallMarkup(response.replace(raw, '').trim());

                    if (!toolIsAvailable) {
                        ensureAssistantPlaceholder();
                        setCurrentThinking('');
                        currentThinkingRef.current = '';
                            setIsThinking(true);
                            response = await continueAfterToolExecution(
                                toolName,
                                effectiveToolArgs,
                                `Error: tool not available: ${toolName}. Use one of the explicitly available tools. For file creation on Windows, use EXECUTE_COMMAND with PowerShell such as Set-Content or Out-File.`,
                                loopHistory,
                                baseSystemPrompt,
                                response,
                        );
                        if (!isCurrentRequest()) return;
                        setIsThinking(false);
                        continue;
                    }

                    if (missingRequiredToolArgs) {
                        ensureAssistantPlaceholder();
                        setCurrentThinking('');
                        currentThinkingRef.current = '';
                        setIsThinking(true);
                        response = await continueAfterToolExecution(
                            toolName,
                            '{}',
                            `Error: ${toolName} requires explicit arguments. Do not emit [TOOL: ${toolName}] by itself. Re-issue the tool call with the required JSON payload and continue the task.`,
                            loopHistory,
                            baseSystemPrompt,
                            response,
                        );
                        if (!isCurrentRequest()) return;
                        setIsThinking(false);
                        continue;
                    }

                    if (windowsCmdSyntaxError) {
                        commandIntercepted = true;
                        setMessages(prev => {
                            const next = [...prev, {
                                role: 'system' as const,
                                content: `${response ? `${response}\n\n` : ''}${t('windowsPsOnly')} ${windowsCmdSyntaxError}`,
                            }];
                            messagesRef.current = next;
                            return next;
                        });
                        response = '';
                        break;
                    }

                    if (toolName === 'execute_command' && commandPolicy.status === 'blocked') {
                        commandIntercepted = true;
                        setMessages(prev => {
                            const next = [...prev, {
                                role: 'system' as const,
                                content: response || t('dangerousCmdBlocked'),
                                commandRequest: {
                                    status: 'blocked' as const,
                                    command: commandText,
                                    reason: commandPolicy.reason || '차단 규칙과 일치했습니다.',
                                },
                            }];
                            messagesRef.current = next;
                            return next;
                        });
                        response = '';
                        break;
                    }

                    if (toolName === 'execute_command' && commandPolicy.status === 'approval') {
                        commandIntercepted = true;
                        setPendingApproval({
                            command: commandText,
                            toolName,
                            toolArgs,
                            historyToSend: [...loopHistory],
                            baseSystemPrompt,
                            responseSansCommand: response,
                        });
                        setMessages(prev => {
                            const next = [...prev, {
                                role: 'system' as const,
                                content: response || t('cmdNeedsApproval'),
                                commandRequest: {
                                    status: 'approval' as const,
                                    command: commandText,
                                    reason: commandPolicy.reason || '사용자 승인이 필요합니다.',
                                },
                            }];
                            messagesRef.current = next;
                            return next;
                        });
                        response = '';
                        break;
                    }

                    setMessages(prev => {
                        const next = [...prev, { role: 'system' as const, content: `🔧 Executing ${toolName}...` }];
                        messagesRef.current = next;
                        return next;
                    });

                    try {
                        const { result, timedOut } = await callToolWithClientTimeout(toolName, effectiveToolArgs);
                        if (!isCurrentRequest()) return;
                        console.log(`[MCP] Tool ${toolName} result:`, result);
                        const toolResultForUi: Message = {
                            role: 'tool',
                            name: toolName,
                            content: `${toolName === 'send_keys' ? 'Keys' : 'Command'}: \`${effectiveCommandText}\`${normalizedSendKeys?.reason ? `\n\nRemap: ${normalizedSendKeys.reason}` : ''}${timedOut ? `\n\nNote: ${t('mcpTimeout')}` : ''}\n\nStatus: ${result}`
                        };
                        setMessages(prev => {
                            const next = [...prev, toolResultForUi];
                            messagesRef.current = next;
                            return next;
                        });
                        appendDebugToolExecution({
                            tool: toolName,
                            args: effectiveToolArgs,
                            result,
                        });
                        if (shouldContinueAfterToolExecution(toolName)) {
                            ensureAssistantPlaceholder();
                            setCurrentThinking('');
                            currentThinkingRef.current = '';
                            setIsThinking(true);
                            setLlmProgress({
                                phase: 'prompt-processing',
                                label: 'Processing Prompt...',
                                percent: 0,
                                active: true,
                            });
                            response = await continueAfterToolExecution(
                                toolName,
                                effectiveToolArgs,
                                result,
                                loopHistory,
                                baseSystemPrompt,
                                response,
                            );
                            if (!isCurrentRequest()) return;
                            setIsThinking(false);
                        } else {
                            appendToolResultToHistory(loopHistory, toolName, effectiveToolArgs, result);
                            ensureAssistantPlaceholder();
                            setCurrentThinking('');
                            currentThinkingRef.current = '';
                            setIsThinking(true);
                            setLlmProgress({
                                phase: 'prompt-processing',
                                label: 'Processing Prompt...',
                                percent: 0,
                                active: true,
                            });
                            response = await inspectTerminalIfNeeded(
                                toolName,
                                effectiveCommandText,
                                loopHistory,
                                baseSystemPrompt,
                                response,
                            );
                            if (!isCurrentRequest()) return;
                            setIsThinking(false);
                        }
                    } catch (err) {
                        if (!isCurrentRequest()) return;
                        response = `Error calling tool ${toolName}: ${err}`;
                        break;
                    }
                } else {
                    // Check if response ended on an incomplete progress-like section
                    if (
                        needsContinuationAfterPlan(response)
                        || needsContinuationAfterTrailingSection(response)
                    ) {
                        ensureAssistantPlaceholder();
                        setCurrentThinking('');
                        currentThinkingRef.current = '';
                        setIsThinking(true);
                        const contHistory = [
                            ...loopHistory,
                            { role: 'assistant' as const, content: response },
                            {
                                role: 'user' as const,
                                content: '[App Notice] The previous reply ended on a progress-like section and appears incomplete. Continue from the last section now and perform the next concrete action or finish the report instead of repeating prior sections.',
                            },
                        ];
                        await syncRecentTerminalContextBuffer(activeTabId);
                        response = await FetchLLMResponse(
                            apiUrl,
                            apiKey,
                            modelName,
                            maxTokens,
                            temperature,
                            provider,
                            true,
                            buildLLMMessages(contHistory, baseSystemPrompt, {
                                includeScreenContext: false,
                            }),
                        );
                        updateDebugTrace({
                            rawResponse: maskSensitiveText(response, apiKey),
                        });
                        if (!isCurrentRequest()) return;
                        setIsThinking(false);
                        continue;
                    }
                    break;
                }
            }

            if (!isCurrentRequest()) return;
            if (!response && !currentThinking && !commandIntercepted) {
                response = t('noResponseError');
            }

            if (commandIntercepted) {
                setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant' && !last.content) {
                        updated.pop();
                    }
                    messagesRef.current = updated;
                    return updated;
                });
                return;
            }

            const reasoningDurationMs = finalizeReasoningDuration();
            setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === 'assistant') {
                    last.content = stripToolCallMarkup(response);
                    last.reasoning = currentThinkingRef.current;
                    last.reasoningDurationMs = reasoningDurationMs;
                }
                messagesRef.current = updated;
                return updated;
            });
        } catch (error: any) {
            if (!isCurrentRequest()) return;
            console.error("[LLM] Error in sendMessage:", error);
            setMessages(prev => {
                const next = [...prev, { role: 'system' as const, content: `❌ LLM Request Failed: ${error.message || error}` }];
                messagesRef.current = next;
                return next;
            });
        } finally {
            if (isCurrentRequest()) {
                setIsLoading(false);
                setIsThinking(false);
                setLlmProgress(null);
                resetReasoningTimer();
            }
        }
    };

    const resetInFlightUiState = () => {
        setPendingApproval(null);
        setIsLoading(false);
        setIsThinking(false);
        setLlmProgress(null);
        setCurrentThinking('');
        currentThinkingRef.current = '';
        resetReasoningTimer();
        setDebugTrace(prev => ({
            ...prev,
            rawResponse: '',
            parsedToolCall: '',
            toolExecutions: [],
            terminalNotes: '',
            updatedAt: Date.now(),
        }));
        if (llmProgressHideTimeoutRef.current !== null) {
            window.clearTimeout(llmProgressHideTimeoutRef.current);
            llmProgressHideTimeoutRef.current = null;
        }
    };

    const handleStop = async () => {
        requestSequenceRef.current += 1;
        await StopLLMResponse();
        resetInFlightUiState();
    };

    useEffect(() => {
        if (!isLoading) return;

        const handleGlobalStopKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            const activeElement = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
            const activeValue = typeof activeElement?.value === 'string' ? activeElement.value : '';
            if (activeValue.trim().length > 0) return;
            event.preventDefault();
            void handleStop();
        };

        window.addEventListener('keydown', handleGlobalStopKey);
        return () => window.removeEventListener('keydown', handleGlobalStopKey);
    }, [isLoading]);

    const clearMessages = async () => {
        requestSequenceRef.current += 1;
        await StopLLMResponse();
        resetInFlightUiState();
        try {
            await ClearTerminalContext(activeTabId);
        } catch (error) {
            console.warn('[Terminal] Failed to clear terminal context buffer:', error);
        }
        recentTerminalBuffersRef.current[activeTabId] = t('terminalEmpty');
        setDebugTrace(createEmptyDebugTrace());
        const nextMessages: Message[] = [{
            role: 'assistant',
            content: `<analysis>System Lifecycle: Reset Success</analysis>
<progress title="DKST Terminal Assistant: New Session" description="System is ready for your next request.">
1. Conversation history cleared
2. Memory buffer released
</progress>
${t('chatCleared')}`
        }];
        messagesRef.current = nextMessages;
        setMessages(nextMessages);
    };

    useEffect(() => {
        console.log("DKST Terminal Assistant: Component Mounted");
    }, []);

    return (
        <div id="App" className="app-container">
            <div className="main-layout">
                <div className="terminal-pane">
                    <div className="pane-header">
                        <div className="tab-list">
                            {tabs.map(tab => (
                                <div key={tab.id} className={`tab-item no-select ${activeTabId === tab.id ? 'active' : ''}`} onClick={() => setActiveTabId(tab.id)}>
                                    {tab.name}
                                    {tabs.length > 1 && <span className="close-tab" onClick={(e) => removeTab(e, tab.id)}>×</span>}
                                </div>
                            ))}
                            <button className="add-tab-btn no-select" onClick={addTab} title="New Tab">+</button>
                        </div>
                        <div className="header-actions">
                            <button className="icon-btn no-select" title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"} onClick={handleToggleFullscreen}>
                                {isFullscreen ? (
                                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
                                        <path d="M9 15H5v4"></path>
                                        <path d="M15 9h4V5"></path>
                                        <path d="M5 15l5-5"></path>
                                        <path d="M19 9l-5 5"></path>
                                    </svg>
                                ) : (
                                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
                                        <path d="M8 3H3v5"></path>
                                        <path d="M16 3h5v5"></path>
                                        <path d="M3 16v5h5"></path>
                                        <path d="M21 16v5h-5"></path>
                                        <path d="M3 8l6-6"></path>
                                        <path d="M21 8l-6-6"></path>
                                        <path d="M3 16l6 6"></path>
                                        <path d="M21 16l-6 6"></path>
                                    </svg>
                                )}
                            </button>
                            <button className="icon-btn no-select" title="Settings" onClick={() => {
                                setIsSettingsOpen(true);
                                if (provider === 'LM Studio' && availableModels.length === 0) {
                                    handleFetchModels();
                                }
                            }}>
                                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                            </button>
                        </div>
                    </div>
                    <div className={`terminal-container-wrapper ${debugPanelEnabled ? 'debug-enabled' : ''}`}>
                        <div className="terminal-stage">
                            {tabs.map(tab => (
                                <div
                                    key={tab.id}
                                    className={`terminal-container ${activeTabId === tab.id ? 'active' : ''}`}
                                    ref={el => terminalContainersRef.current[tab.id] = el}
                                    onMouseDown={() => {
                                        setActiveTabId(tab.id);
                                        xtermsRef.current[tab.id]?.focus();
                                    }}
                                ></div>
                            ))}
                        </div>
                        {debugPanelEnabled && (
                            <aside className="debug-panel">
                                <div className="debug-panel-header no-select">
                                    <span>Debug Trace</span>
                                    <span className="debug-panel-meta">{debugTrace.updatedAt ? new Date(debugTrace.updatedAt).toLocaleTimeString() : 'idle'}</span>
                                </div>
                                <div className="debug-tab-row no-select">
                                    {([
                                        ['context', 'Context'],
                                        ['request', 'LLM Request'],
                                        ['response', 'LLM Response'],
                                        ['tools', 'Tools'],
                                        ['terminal', 'Terminal'],
                                    ] as Array<[DebugPanelTab, string]>).map(([tabId, label]) => (
                                        <button
                                            key={tabId}
                                            className={`debug-tab-btn no-select ${debugPanelTab === tabId ? 'active' : ''}`}
                                            onClick={() => setDebugPanelTab(tabId)}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                                <div className="debug-panel-body">
                                    <pre>{renderDebugPanelContent()}</pre>
                                </div>
                            </aside>
                        )}
                    </div>
                </div>

                <div className="pane-resizer" onMouseDown={() => { isResizing.current = true; document.body.style.cursor = 'col-resize'; }}></div>

                <div className="chat-pane" style={{ width: `${chatWidth}px` }}>
                    <div className="pane-header">
                        <div className="header-title no-select">Assistant</div>
                        <div className="header-actions">
                            <button className="icon-btn no-select" title="Clear History" onClick={clearMessages}>
                                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                            </button>
                        </div>
                    </div>
                    <div className="chat-content" style={{ fontSize: `${chatFontSize}px`, fontFamily: chatFontFamily }}>
                        <div className="message-list">
                            {messages.map((m, i) => (
                                <div key={i} className={`message ${m.role}`}>
                                    <div className="message-label no-select">
                                        {m.role === 'user' ? 'YOU' : m.role === 'tool' ? 'TOOL' : m.role === 'system' ? 'SYSTEM' : ASSISTANT_DISPLAY_NAME.toUpperCase()}
                                    </div>
                                    {m.role === 'assistant' && (
                                        <>
                                            {/* Historical reasoning */}
                                            {m.reasoning && !isLoading && (
                                                <ReasoningBox content={m.reasoning} isThinking={false} durationMs={m.reasoningDurationMs} />
                                            )}
                                            {/* Active reasoning for the last message */}
                                            {i === messages.length - 1 && isLoading && (currentThinking || isThinking) && (
                                                <ReasoningBox content={currentThinking} isThinking={isThinking} durationMs={currentReasoningDurationMs} />
                                            )}
                                        </>
                                    )}
                                    <div className="bubble">
                                        <div dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                                        {m.commandRequest && (
                                            <div className={`command-approval ${m.commandRequest.status}`}>
                                                <div className="command-approval-reason">{m.commandRequest.reason}</div>
                                                <div className="command-approval-command">
                                                    <code>{m.commandRequest.command}</code>
                                                </div>
                                                {m.commandRequest.status === 'approval' && (
                                                    <div className="command-approval-actions">
                                                        <button className="approval-cancel-btn" onClick={() => handleCommandApprovalDecision(false)}>{t('close')}</button>
                                                        <button className="approval-run-btn" onClick={() => handleCommandApprovalDecision(true)}>{t('run')}</button>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                            <div ref={chatEndRef} />
                        </div>
                    </div>
                    {isLoading && provider === 'LM Studio' && llmProgress?.active && (
                        <div className="chat-progress-dock">
                            <LLMProgressCard progress={llmProgress} />
                        </div>
                    )}
                    <div className="chat-input-area">
                        <div className="input-wrapper" style={{ fontSize: `${chatFontSize}px`, fontFamily: chatFontFamily }}>
                            <textarea
                                ref={chatInputRef}
                                className="chat-input"
                                placeholder={isLoading ? t('chatLoadingPlaceholder') : t('chatPlaceholder')}
                                value={inputText}
                                onChange={e => setInputText(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                                {...textAssistOffProps}
                            ></textarea>
                            {isLoading ? (
                                <button className="stop-btn" onClick={handleStop} title={t('stop')} aria-label={t('stop')}>
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                        <rect x="6" y="6" width="12" height="12" rx="1.5"></rect>
                                    </svg>
                                </button>
                            ) : (
                                <button className="send-btn" onClick={sendMessage} title={t('send')} aria-label={t('send')}>
                                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M5 12h12"></path>
                                        <path d="M13 5l7 7-7 7"></path>
                                    </svg>
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {isSettingsOpen && (
                    <div className="settings-overlay" onClick={() => setIsSettingsOpen(false)}>
                        <div className="settings-modal" onClick={e => e.stopPropagation()}>
                            <button className="close-icon-btn" onClick={() => setIsSettingsOpen(false)}>×</button>
                            <div className="settings-header">
                                <h3>{t('settings')}</h3>
                            </div>
                            <div className="settings-tabs-content">
                                <div className="settings-section">
                                    <h4>{t('llmConfig')}</h4>
                                    <div className="settings-grid">
                                        <div className="settings-field">
                                            <label>{t('language')}</label>
                                            <select value={language} onChange={e => setLanguage(e.target.value as Language)}>
                                                <option value="ko">한국어</option>
                                                <option value="en">English</option>
                                                <option value="ja">日本語</option>
                                                <option value="zh">中文</option>
                                            </select>
                                        </div>
                                        <div className="settings-field">
                                            <label>{t('serverUrl')}</label>
                                            <input type="text" value={apiUrl} onChange={e => setApiUrl(e.target.value)} placeholder="127.0.0.1:1234" {...textAssistOffProps} />
                                            <span className="settings-hint">{t('urlHint')}</span>
                                        </div>
                                        <div className="settings-field">
                                            <label>{t('modelKey')}</label>
                                            <div className="model-selection-group">
                                                {provider === 'LM Studio' && availableModels.length > 0 ? (
                                                    <select
                                                        value={modelName}
                                                        onChange={e => setModelName(e.target.value)}
                                                        className="model-select"
                                                    >
                                                        {availableModels.map(m => (
                                                            <option key={m} value={m}>{m}</option>
                                                        ))}
                                                    </select>
                                                ) : (
                                                    <input type="text" value={modelName} onChange={e => setModelName(e.target.value)} {...textAssistOffProps} />
                                                )}
                                                {provider === 'LM Studio' && (
                                                    <button
                                                        className="refresh-models-btn"
                                                        onClick={handleFetchModels}
                                                        disabled={isFetchingModels}
                                                        title={t('fetchModels')}
                                                    >
                                                        {isFetchingModels ? '...' : t('fetchModels')}
                                                    </button>
                                                )}
                                            </div>
                                            <span className="settings-hint">{t('modelHint')}</span>
                                        </div>
                                        <div className="settings-field">
                                            <label>{t('llmProvider')}</label>
                                            <select value={provider} onChange={e => setProvider(e.target.value)}>
                                                <option>LM Studio</option><option>OpenAI</option><option>Ollama</option><option>Custom</option>
                                            </select>
                                            <span className="settings-hint">{t('providerHint')}</span>
                                        </div>
                                        <div className="settings-field">
                                            <label>{provider === 'LM Studio' || provider === 'Ollama' ? t('apiKey') : t('apiKeyRequired')}</label>
                                            <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="OpenAI or Local key" {...textAssistOffProps} />
                                        </div>
                                        <div className="settings-field">
                                            <label>{t('maxTokens')}</label>
                                            <input
                                                type="text"
                                                inputMode="numeric"
                                                pattern="[0-9]*"
                                                value={maxTokensInput}
                                                onChange={e => setMaxTokensInput(keepDigitsOnly(e.target.value))}
                                                {...textAssistOffProps}
                                            />
                                            <span className="settings-hint">{t('tokensHint')}</span>
                                        </div>
                                        <div className="settings-field"><label>{t('temperature')}</label><input type="number" step="0.1" value={temperature} onChange={e => setTemperature(Number(e.target.value))} /></div>
                                        <div className="settings-field full">
                                            <label>{t('globalUserPrompt')}</label>
                                            <textarea
                                                className="settings-textarea settings-prompt-textarea"
                                                value={globalUserPrompt}
                                                onChange={e => setGlobalUserPrompt(e.target.value)}
                                                placeholder={t('globalUserPromptPlaceholder')}
                                                {...textAssistOffProps}
                                            />
                                            <span className="settings-hint">{t('globalUserPromptHint')}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="settings-section">
                                    <h4>{t('appearance')}</h4>
                                    <div className="settings-grid">
                                        <div className="settings-field"><label>{t('chatFontSize')}</label><input type="number" min="10" max="28" value={chatFontSize} onChange={e => setChatFontSize(clampChatFontSize(Number(e.target.value)))} /></div>
                                        <div className="settings-field"><label>{t('chatFontFamily')}</label><input type="text" value={chatFontFamily} onChange={e => setChatFontFamily(e.target.value)} {...textAssistOffProps} /></div>
                                    </div>
                                </div>
                                <div className="settings-section">
                                    <h4>Terminal {t('appearance')}</h4>
                                    <div className="settings-grid">
                                        <div className="settings-field"><label>{t('termFontSize')}</label><input type="number" min="10" max="24" value={termFontSize} onChange={e => setTermFontSize(clampTerminalFontSize(Number(e.target.value)))} /></div>
                                        <div className="settings-field"><label>{t('termFontFamily')}</label><input type="text" value={termFontFamily} onChange={e => setTermFontFamily(e.target.value)} {...textAssistOffProps} /></div>
                                        <div className="settings-field"><label>{t('termForeground')}</label><input type="color" value={termForeground} onChange={e => setTermForeground(e.target.value)} /></div>
                                        <div className="settings-field"><label>{t('termBackground')}</label><input type="color" value={termBackground} onChange={e => setTermBackground(e.target.value)} /></div>
                                    </div>
                                </div>
                                <div className="settings-section">
                                    <div className="settings-section-title">
                                        <h4>{t('mcpConfig')}</h4>
                                        <button
                                            className="settings-help-btn"
                                            type="button"
                                            onClick={() => setIsMcpDocsOpen(true)}
                                            title={t('mcpDocsBtn')}
                                            aria-label={t('mcpDocsBtn')}
                                        >
                                            ?
                                        </button>
                                    </div>
                                    <div className="settings-grid">
                                        <div className="settings-field">
                                            <label>{t('mcpPort')}</label>
                                            <input
                                                type="text"
                                                inputMode="numeric"
                                                pattern="[0-9]*"
                                                value={mcpPortInput}
                                                onChange={e => setMcpPortInput(keepDigitsOnly(e.target.value))}
                                                {...textAssistOffProps}
                                            />
                                        </div>
                                        <div className="settings-field">
                                            <label>{t('mcpLabel')}</label>
                                            <input type="text" value={mcpLabel} onChange={e => setMcpLabel(e.target.value)} {...textAssistOffProps} />
                                            <span style={{ fontSize: '10px', opacity: 0.5 }}>{t('mcpLabelHint')}</span>
                                        </div>
                                    </div>
                                    <h4 style={{ marginTop: '20px' }}>{t('toolManagement')}</h4>
                                    <div className="tool-toggle-list">
                                        {availableTools.map(tool => (
                                            <div key={tool.name} className="tool-toggle-item">
                                                <label>
                                                    <input type="checkbox" checked={enabledTools.includes(tool.name)} onChange={e => e.target.checked ? setEnabledTools([...enabledTools, tool.name]) : setEnabledTools(enabledTools.filter(t => t !== tool.name))} />
                                                    <span>{tool.name}</span>
                                                </label>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                <div className="settings-section">
                                    <h4>{t('commandSafety')}</h4>
                                    <div className="settings-grid">
                                        <div className="settings-field full">
                                            <div className="settings-field-header">
                                                <label>{t('blockedCmds')}</label>
                                                <button className="mini-reset-btn" onClick={() => setBlockedCommandPatterns(DEFAULT_BLOCKED_COMMAND_PATTERNS)}>{t('defaultBtn')}</button>
                                            </div>
                                            <textarea
                                                className="settings-textarea"
                                                value={blockedCommandPatterns}
                                                onChange={e => setBlockedCommandPatterns(e.target.value)}
                                                {...textAssistOffProps}
                                            />
                                            <span style={{ fontSize: '10px', opacity: 0.6 }}>{t('blockedHint')}</span>
                                        </div>
                                        <div className="settings-field full">
                                            <div className="settings-field-header">
                                                <label>{t('requireApproval')}</label>
                                                <button className="mini-reset-btn" onClick={() => setApprovalCommandPatterns(DEFAULT_APPROVAL_COMMAND_PATTERNS)}>{t('defaultBtn')}</button>
                                            </div>
                                            <textarea
                                                className="settings-textarea"
                                                value={approvalCommandPatterns}
                                                onChange={e => setApprovalCommandPatterns(e.target.value)}
                                                {...textAssistOffProps}
                                            />
                                            <span style={{ fontSize: '10px', opacity: 0.6 }}>{t('approvalHint')}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="settings-section">
                                    <h4>Debug</h4>
                                    <div className="settings-grid">
                                        <div className="settings-field full">
                                            <label className="settings-checkbox-row">
                                                <span className="settings-checkbox-control">
                                                    <input
                                                        type="checkbox"
                                                        checked={debugPanelEnabled}
                                                        onChange={e => setDebugPanelEnabled(e.target.checked)}
                                                    />
                                                </span>
                                                <span className="settings-checkbox-copy">
                                                    <span className="settings-checkbox-title">Show debug side panel inside the terminal area</span>
                                                </span>
                                            </label>
                                            <span className="settings-hint">Displays the final screen context, LLM request payload, raw LLM response, parsed tool calls, tool execution results, and terminal follow-up notes.</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div className="settings-footer">
                                <div className="settings-footer-copy">(C) 2026 DINKI&apos;ssTyle</div>
                                <button className="save-btn" onClick={handleSaveSettings}>{t('applySave')}</button>
                            </div>
                        </div>
                    </div>
                )}
                {isMcpDocsOpen && (
                    <div className="settings-overlay docs-overlay" onClick={() => setIsMcpDocsOpen(false)}>
                        <div className="docs-modal" onClick={e => e.stopPropagation()}>
                            <div className="docs-modal-header">
                                <h3>{t('mcpDocsTitle')}</h3>
                                <button className="close-icon-btn" onClick={() => setIsMcpDocsOpen(false)}>×</button>
                            </div>
                            <div className="docs-modal-body">
                                <div className="bubble docs-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(mcpDocsContent) }} />
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default App;
