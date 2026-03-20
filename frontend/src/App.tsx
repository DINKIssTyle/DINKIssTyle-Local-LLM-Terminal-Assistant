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
import { StartTerminal, WriteToTerminal, ResizeTerminal, FetchLLMResponse, CallTool, GetTools, StopTerminal, SetActiveTab, UpdateMCPSettings, StopLLMResponse } from "../wailsjs/go/main/App";
import { EventsOn, EventsEmit } from "../wailsjs/runtime/runtime";

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
        lines.every(line => line.includes('|')) &&
        /^\s*\|?[\-\s:|]+\|?\s*$/.test(lines[1]);

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
        .replace(/<progress[^>]*>([\s\S]*?)<\/progress>/gi, '$1')
        .replace(/<tasklist[^>]*>([\s\S]*?)<\/tasklist>/gi, '$1')
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

    html = html.replace(/<progress title="([^"]*)" description="([^"]*)">([\s\S]*?)<\/progress>/gi, (_, title, desc, content) => {
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
            <div class="progress-description">${renderInlineMarkdown(desc)}</div>
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

    html = html.replace(/<tasklist title="([^"]*)" description="([^"]*)">([\s\S]*?)<\/tasklist>/gi, (_, title, desc, content) => {
        const items = renderStructuredItems(extractStructuredListItems(content));

        return stash(`<section class="message-block tasklist-block">
            <div class="progress-header">
                <span>${renderInlineMarkdown(title)}</span>
                <span class="progress-meta">Tasks</span>
            </div>
            <div class="progress-description">${renderInlineMarkdown(desc)}</div>
            <div class="progress-list">${items}</div>
        </section>`);
    });

    html = html.replace(/<walkthrough title="([^"]*)" description="([^"]*)">([\s\S]*?)<\/walkthrough>/gi, (_, title, desc, content) => {
        const items = renderStructuredItems(extractStructuredListItems(content));

        return stash(`<section class="message-block walkthrough-block">
            <div class="progress-header">
                <span>${renderInlineMarkdown(title)}</span>
                <span class="progress-meta">Walkthrough</span>
            </div>
            <div class="progress-description">${renderInlineMarkdown(desc)}</div>
            <div class="progress-list">${items}</div>
        </section>`);
    });

    html = html.replace(/<report title="([^"]*)" description="([^"]*)">([\s\S]*?)<\/report>/gi, (_, title, desc, content) => {
        const items = renderStructuredItems(extractStructuredListItems(content));

        return stash(`<section class="message-block report-block">
            <div class="progress-header">
                <span>${renderInlineMarkdown(title)}</span>
                <span class="progress-meta">Report</span>
            </div>
            <div class="progress-description">${renderInlineMarkdown(desc)}</div>
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

    html = html.replace(/<artifact([^>]*)>/gi, (_, attrs) => {
        const typeMatch = attrs.match(/type="([^"]*)"/i);
        const idMatch = attrs.match(/id="([^"]*)"/i);
        const title = humanizeArtifactLabel(idMatch?.[1] || 'Artifact');
        const type = humanizeArtifactLabel(typeMatch?.[1] || 'artifact');
        return stash(`<section class="artifact-card">
            <div class="artifact-header">
                <div class="artifact-title">${renderInlineMarkdown(title)}</div>
            </div>
            <div class="artifact-type">${renderInlineMarkdown(type)}</div>
        </section>`);
    });

    html = html.replace(/<\/artifact>/gi, '');

    html = html.replace(/>>>\s*EXECUTE_COMMAND:\s*"([\s\S]*?)"\s*<<</g, (_, command) => {
        return stash(`<section class="message-block command-block">
            <div class="command-header">
                <span>Run In Terminal</span>
                <span class="progress-meta">Action</span>
            </div>
            <div class="command-body"><code>${escapeHtml(command.trim())}</code></div>
        </section>`);
    });

    html = html.replace(/>>>\s*SEND_KEYS:\s*(\[[\s\S]*?\])\s*<<</g, (_, keysJson) => {
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
            const command = typeof payload.command === 'string' ? payload.command.trim() : payloadJson.trim();
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
            const keys = Array.isArray(payload.keys) ? JSON.stringify(payload.keys) : payloadJson.trim();
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

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, language, code) => {
        return stash(`<pre><code class="language-${escapeHtml(language || 'plain')}">${escapeHtml(code.trim())}</code></pre>`);
    });

    html = html
        .split(/\n{2,}/)
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

const parseToolCallFromResponse = (response: string): ParsedToolCall | null => {
    const executeRegex = />>>\s*EXECUTE_COMMAND:\s*"([\s\S]*?)"\s*<<</;
    const sendKeysRegex = />>>\s*SEND_KEYS:\s*(\[[\s\S]*?\])\s*<<</;
    const bracketToolRegex = /\[TOOL:\s*([a-zA-Z0-9_:-]+)\s*({[\s\S]*?})\s*\]/i;

    const commandMatch = response.match(executeRegex);
    if (commandMatch) {
        const command = commandMatch[1];
        return {
            raw: commandMatch[0],
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

    const bracketMatch = response.match(bracketToolRegex);
    if (!bracketMatch) return null;

    try {
        const toolName = bracketMatch[1].toLowerCase();
        const payload = JSON.parse(bracketMatch[2]);
        if (toolName === 'execute_command' && typeof payload.command === 'string') {
            return {
                raw: bracketMatch[0],
                toolName,
                commandText: payload.command,
                parsedKeys: [],
                toolArgs: JSON.stringify({ command: payload.command }),
            };
        }

        if (toolName === 'send_keys' && Array.isArray(payload.keys) && payload.keys.every((item: unknown) => typeof item === 'string')) {
            return {
                raw: bracketMatch[0],
                toolName,
                commandText: JSON.stringify(payload.keys),
                parsedKeys: payload.keys,
                toolArgs: JSON.stringify({ keys: payload.keys }),
            };
        }

        if (payload && typeof payload === 'object') {
            const summarizedArgument = typeof payload.query === 'string'
                ? payload.query
                : typeof payload.url === 'string'
                    ? payload.url
                    : typeof payload.keyword === 'string'
                        ? payload.keyword
                        : JSON.stringify(payload);

            return {
                raw: bracketMatch[0],
                toolName,
                commandText: summarizedArgument,
                parsedKeys: [],
                toolArgs: JSON.stringify(payload),
            };
        }
    } catch {
        return null;
    }

    return null;
};

const isAppNewTabShortcut = (keys: string[]): boolean => {
    const normalized = normalizeShortcutTokens(keys);
    const hasModifier = normalized.includes('CTRL') || normalized.includes('CONTROL') || normalized.includes('CMD') || normalized.includes('COMMAND') || normalized.includes('META');
    return hasModifier && normalized.includes('SHIFT') && normalized.includes('T');
};

const LLMProgressCard = ({ progress }: { progress: LLMProgressState | null }) => {
    if (!progress?.active) return null;

    return (
        <div className={`llm-progress-card ${progress.phase}`}>
            <div className="llm-progress-text">
                <span className="llm-progress-label">{progress.label}</span>
                <span className="llm-progress-percent">{Math.max(0, Math.min(100, Math.round(progress.percent)))}%</span>
            </div>
            <div className="llm-progress-track">
                <div className="llm-progress-fill" style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}></div>
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

const isComplexRequest = (request: string): boolean => {
    const normalized = request.trim().toLowerCase();
    if (!normalized) return false;

    const keywordHits = COMPLEX_REQUEST_KEYWORDS.filter(keyword => normalized.includes(keyword)).length;
    const sentenceCount = normalized.split(/[.!?\n]/).map(token => token.trim()).filter(Boolean).length;
    const conjunctionHits = (normalized.match(/\b(and|then|after|before|with|plus)\b/g) || []).length
        + (normalized.match(/그리고|다음|이후|전에|및|해서|해서도|하면서/g) || []).length;

    return normalized.length >= 140 || keywordHits >= 2 || sentenceCount >= 3 || conjunctionHits >= 2;
};

const buildTaskWorkflowPrompt = (complexRequest: boolean): string => {
    if (!complexRequest) return '';

    return `
5. COMPLEX TASK MODE: If the user's request is multi-step, implementation-heavy, review-heavy, or explicitly asks for a workflow, you MUST structure your response and execution like an agent runbook.
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

const detectWindowsCmdSyntax = (command: string): string | null => {
    const normalized = command.trim().toLowerCase();
    if (!normalized) return null;

    const patterns: Array<{ pattern: RegExp; message: string }> = [
        { pattern: /\bif\s+exist\b/, message: '`if exist`는 cmd.exe 문법입니다. PowerShell에서는 `if (Test-Path ...) { ... }`를 사용해야 합니다.' },
        { pattern: /\bdir\b(?:\s|$)/, message: '`dir` 대신 PowerShell cmdlet이나 `Get-ChildItem`을 사용하세요.' },
        { pattern: /\bcopy\b(?:\s|$)/, message: '`copy` 대신 `Copy-Item`을 사용하세요.' },
        { pattern: /\bdel\b(?:\s|$)/, message: '`del` 대신 `Remove-Item`을 사용하세요.' },
        { pattern: /\btype\b(?:\s|$)/, message: '`type` 대신 `Get-Content`를 사용하세요.' },
        { pattern: /\bset\s+[a-z_][a-z0-9_]*=/, message: '`set VAR=value`는 cmd.exe 문법입니다. PowerShell에서는 `$env:VAR = "value"`를 사용하세요.' },
        { pattern: /%[a-z0-9_]+%/i, message: '`%VAR%` 환경변수 문법은 cmd.exe 방식입니다. PowerShell에서는 `$env:VAR`를 사용하세요.' },
        { pattern: /\b&&\b|\b\|\|\b/, message: '`&&` 또는 `||` 대신 PowerShell의 `;`, `if`, `-and`, `-or` 등을 사용하세요.' },
    ];

    const match = patterns.find(({ pattern }) => pattern.test(normalized));
    return match ? match.message : null;
};

const ReasoningBox = ({ content, isThinking }: { content: string, isThinking: boolean }) => {
    const [isCollapsed, setIsCollapsed] = useState(!isThinking);

    useEffect(() => {
        if (isThinking) setIsCollapsed(false);
    }, [isThinking]);

    if (!content && !isThinking) return null;

    return (
        <div className={`reasoning-status ${isCollapsed ? 'collapsed' : ''}`} style={{ background: '#111', border: 'none' }}>
            <div className="reasoning-header" onClick={() => setIsCollapsed(!isCollapsed)} style={{ color: '#888', textTransform: 'none', border: 'none' }}>
                <span style={{ fontSize: '10px' }}>{isCollapsed ? '▶' : '▼'}</span>
                <span>{isThinking ? 'Thinking...' : 'Thought for 3s'}</span>
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
    }, [language, apiUrl, apiKey, modelName, maxTokens, temperature, provider, termFontSize, termFontFamily, termForeground, termBackground, chatFontSize, chatFontFamily, chatWidth, mcpPort, mcpLabel, blockedCommandPatterns, approvalCommandPatterns, enabledTools]);

    const handleSaveSettings = () => {
        UpdateMCPSettings(mcpPort, mcpLabel);
        setIsSettingsOpen(false);
        setIsMcpDocsOpen(false);
    };

    useEffect(() => {
        UpdateMCPSettings(mcpPort, mcpLabel).catch((error) => {
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
    const [llmProgress, setLlmProgress] = useState<LLMProgressState | null>(null);
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [isFetchingModels, setIsFetchingModels] = useState(false);

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
            setCurrentThinking(prev => prev + chunk);
            setIsThinking(true);
        });

        const unoffProgress = EventsOn("llm:status", (payload: any) => {
            if (!payload?.active) {
                setLlmProgress(null);
                return;
            }

            const phase = payload.phase === 'model-load' ? 'model-load' : 'prompt-processing';
            setLlmProgress({
                phase,
                label: payload.label || (phase === 'model-load' ? 'Loading Model...' : 'Processing Prompt...'),
                percent: Number(payload.percent || 0),
                active: true,
            });
        });

        return () => {
            unoffChunk();
            unoffThinking();
            unoffProgress();
        };
    }, []);

    const scrollToBottom = () => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    const scheduleTerminalFit = (tabId: string) => {
        const runFit = () => {
            const fitAddon = fitAddonsRef.current[tabId];
            const term = xtermsRef.current[tabId];
            if (!fitAddon || !term) return;

            try {
                fitAddon.fit();
                term.scrollToBottom();
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
                term.write(data);
                scheduleTerminalFit(tab.id);
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
        }
    }, [activeTabId, chatWidth]);

    useEffect(() => {
        GetTools().then(setAvailableTools);
    }, []);

    const addTab = () => {
        openNewTab();
    };

    const removeTab = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
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

    const getVisibleTerminalText = (): string => {
        const term = xtermsRef.current[activeTabId] as any;
        if (!term?.buffer?.active) return 'Terminal text unavailable.';

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
            const text = line.translateToString(true).trimEnd();
            if (text) lines.push(text);
        }

        return lines.join('\n') || 'Terminal viewport is currently empty.';
    };

    const buildScreenContext = (history: Message[]): string => {
        const activeTab = tabs.find(tab => tab.id === activeTabId);
        const visibleChat = history.slice(-6).map(message => {
            const roleLabel = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role;
            return `${roleLabel}: ${stripMarkupForContext(message.content).slice(0, 500) || '(empty)'}`;
        }).join('\n');

        return [
            `ACTIVE_TAB: ${activeTab?.name || activeTabId}`,
            `CHAT_WIDTH: ${chatWidth}px`,
            'VISIBLE_TERMINAL:',
            getVisibleTerminalText(),
            'VISIBLE_CHAT:',
            visibleChat || 'No visible chat messages.',
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
                reason: `차단 규칙 "${blockedMatch}" 과 일치하여 앱이 실행을 막았습니다.`,
            };
        }

        const approvalMatch = parseSafetyPatterns(approvalCommandPatterns).find(pattern => matchesCommandPattern(command, pattern));
        if (approvalMatch) {
            return {
                status: 'approval',
                reason: `승인 규칙 "${approvalMatch}" 과 일치하여 사용자 확인이 필요합니다.`,
            };
        }

        return { status: 'allow' };
    };

    const buildLLMMessages = (history: Message[], baseSystemPrompt: string) => {
        const screenContext = buildScreenContext(history);
        return [{
            role: 'system',
            content: `${baseSystemPrompt}\n\nSCREEN_CONTEXT:\n${screenContext}`
        }, ...history];
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

        let nextResponse = '';
        if (responseSansCommand) {
            nextResponse = responseSansCommand;
        }

        const llmMessages = buildLLMMessages(historyToSend, baseSystemPrompt);
        nextResponse = await FetchLLMResponse(apiUrl, apiKey, modelName, maxTokens, temperature, provider, true, llmMessages);
        return nextResponse;
    };

    const appendToolResultToHistory = (
        history: Message[],
        toolName: string,
        toolArgs: string,
        result: string,
    ) => {
        const toolRole: 'tool' | 'user' = (provider === 'OpenAI') ? 'tool' : 'user';
        const toolContent = (toolRole === 'user') ? `[Tool Response from ${toolName}]: ${result}` : result;
        const toolResultMsg: Message = { role: toolRole, content: toolContent, name: toolName };

        history.push({ role: 'assistant', content: `[TOOL: ${toolName} ${toolArgs}]` });
        history.push(toolResultMsg);
    };

    const getLatestUserRequest = (history: Message[]): string => {
        for (let index = history.length - 1; index >= 0; index -= 1) {
            const message = history[index];
            if (message.role === 'user' && message.content?.trim()) {
                return message.content.trim();
            }
        }
        return '';
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
6. TERMINAL FOLLOW-UP FORMAT: If the request has been satisfied, answer it directly in natural Korean and mention the supporting evidence briefly. If it failed, start with "작업이 실패했습니다." and explain why. If the result is still inconclusive, start with "작업이 아직 진행 중이거나 완료 여부가 불분명합니다." and explain what is missing. If terminal output alone is inconclusive, use SCREEN_CONTEXT to check whether the prompt returned or the visible app state suggests completion. Do not emit tool calls in this follow-up summary.
7. If COMPLEX TASK MODE applies, preserve the same runbook style and end with a <report> block instead of a plain summary when possible.`;

        const terminalContext: Message[] = [
            ...historyToSend,
            {
                role: 'user',
                content: `[Latest user request]\n${userRequest || '(missing)'}\n\n[Executed command]\n${commandText}\n\n[Terminal output after the command]\n${terminalTail}`,
            },
        ];

        const llmMessages = buildLLMMessages(terminalContext, analysisPrompt);
        return FetchLLMResponse(apiUrl, apiKey, modelName, maxTokens, temperature, provider, true, llmMessages);
    };

    const shouldContinueAfterToolExecution = (toolName: string) => {
        return toolName !== 'execute_command' && toolName !== 'send_keys';
    };

    const buildTerminalToolSummary = (toolName: string, commandText: string, responseSansCommand: string) => {
        if (responseSansCommand) {
            return responseSansCommand;
        }

        if (toolName === 'execute_command') {
            return `\`${commandText}\` 명령을 터미널로 보냈습니다. 결과는 왼쪽 터미널에서 확인하세요.`;
        }

        if (toolName === 'send_keys') {
            return '터미널에 키 입력을 전송했습니다.';
        }

        return `\`${toolName}\` 도구를 실행했습니다.`;
    };

    const inspectTerminalIfNeeded = async (
        toolName: string,
        commandText: string,
        historyToSend: Message[],
        baseSystemPrompt: string,
        responseSansCommand: string,
    ) => {
        if (toolName !== 'execute_command' || !shouldInspectTerminalAfterCommand(commandText)) {
            return buildTerminalToolSummary(toolName, commandText, responseSansCommand);
        }

        const tailArgs = JSON.stringify({ lines: 60, maxWaitMs: 4000, idleMs: 1200 });
        const tail = await CallTool('read_terminal_tail', tailArgs);

        return summarizeTerminalTail(getLatestUserRequest(historyToSend), commandText, tail, [...historyToSend], baseSystemPrompt);
    };

    const ensureAssistantPlaceholder = () => {
        setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
                return prev;
            }
            return [...prev, { role: 'assistant', content: '', reasoning: '' }];
        });
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
                        content: `명령 실행이 취소되었습니다.\n\nCommand: \`${request.command}\``,
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
                    content: `사용자 승인을 받아 명령을 실행합니다.\n\nCommand: \`${request.command}\``,
                }
                : message
        )));

        setIsLoading(true);
        setIsThinking(false);
        setCurrentThinking('');

        try {
            const result = await CallTool(request.toolName, request.toolArgs);
            setMessages(prev => [...prev, {
                role: 'tool',
                name: request.toolName,
                content: `Command: \`${request.command}\`\n\nStatus: ${result}`
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

            setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') {
                    last.content = response || '명령 실행은 완료되었지만 후속 응답이 비어 있습니다.';
                    last.reasoning = currentThinking;
                    return updated;
                }
                return [...updated, { role: 'assistant', content: response || '명령 실행은 완료되었지만 후속 응답이 비어 있습니다.', reasoning: currentThinking }];
            });
        } catch (error: any) {
            setMessages(prev => [...prev, { role: 'system', content: `❌ 승인된 명령 실행 실패: ${error.message || error}` }]);
        } finally {
            setIsLoading(false);
            setIsThinking(false);
        }
    };

    const sendMessage = async () => {
        if (!inputText.trim() || isLoading) return;

        console.log("Sending message...", inputText);
        const userMessage: Message = { role: 'user', content: inputText };
        const newMessages = [...messages, userMessage];
        setMessages(newMessages);
        setInputText('');
        setIsLoading(true);
        setCurrentThinking('');

        try {
            const activeTools = availableTools.filter(t => enabledTools.includes(t.name));
            console.log(`[LLM] Initiating request to ${apiUrl} with ${activeTools.length} tools enabled.`);
            console.log(`[LLM] Model: ${modelName}, Provider: ${provider}`);
            const complexRequest = isComplexRequest(inputText);

            const baseSystemPrompt = `You are ${mcpLabel}, a professional AI engineer. 
1. UI: Use <analysis>, <progress>, and <artifact> blocks when they add value. Keep answers compact and readable in a narrow side chat.
2. SCREEN AWARENESS: You receive SCREEN_CONTEXT describing what is visible in the app right now. Use SCREEN_CONTEXT only when the task is specifically about what is visible on screen, terminal/editor UI state, or recent chat content. Do NOT use SCREEN_CONTEXT as proof for filesystem facts, file counts, command results, paths, or other verifiable system state when you can check them with tools. For counts, paths, file existence, file contents, process state, or command output, prefer tools first.
3. TOOLS: To run a terminal command, YOU MUST output this EXACT line:
   >>> EXECUTE_COMMAND: "YOUR_COMMAND" <<<
   To send terminal key presses, YOU MUST output this EXACT line:
   >>> SEND_KEYS: ["ESC", ":q!", "ENTER"] <<<
   To call any other MCP tool such as search_web, read_web_page, get_current_time, naver_search, or namu_wiki, YOU MUST output this EXACT format:
   [TOOL: tool_name {"arg":"value"}]
   
Example: To check the home folder, output:
>>> EXECUTE_COMMAND: "cd ~ && ls" <<<
Example: To exit vim without saving, output:
>>> SEND_KEYS: ["ESC", ":q!", "ENTER"] <<<
Example: To search the web, output:
[TOOL: search_web {"query":"Apple M4 Pro GPU benchmark"}]
Example: To read a page, output:
[TOOL: read_web_page {"url":"https://example.com"}]

ALWAYS use the tool when the user asks for terminal actions.
If the user asks for latest web information, website verification, or online reading, use search_web and read_web_page instead of saying web browsing is unavailable.
If the user asks to count files, inspect directories, verify paths, read files, or confirm system state, use terminal commands even if something similar is visible in SCREEN_CONTEXT.
When Current OS indicates Windows, assume the terminal shell is PowerShell. Use PowerShell syntax only. Do not use cmd.exe or batch syntax such as \`if exist\`, \`dir /b\`, \`copy\`, \`del\`, \`type\`, \`set VAR=\`, or \`%VAR%\`.
4. STYLE: Aim for a VS Code / Antigravity side-panel tone with minimal vertical waste.${buildTaskWorkflowPrompt(complexRequest)}
Current OS: ${window.navigator.platform}
Complex Request Mode: ${complexRequest ? 'enabled' : 'disabled'}`;

            const historyToSend = newMessages.filter((msg, idx) => {
                if (idx === 0 && msg.role === 'assistant') return false;
                return true;
            });
            const loopHistory = [...historyToSend];

            let currentMessages: any[] = buildLLMMessages(loopHistory, baseSystemPrompt);
            console.log("[LLM] Sending Payload:", JSON.stringify(currentMessages, null, 2));
            let response = '';
            let commandIntercepted = false;
            setCurrentThinking('');
            setIsThinking(true);

            // Initialize assistant message for streaming
            setMessages(prev => [...prev, { role: 'assistant', content: '', reasoning: '' }]);

            try {
                // Call StopLLMResponse safely
                if ((window as any).go?.main?.App?.StopLLMResponse) {
                    await (window as any).go.main.App.StopLLMResponse();
                }

                response = await FetchLLMResponse(apiUrl, apiKey, modelName, maxTokens, temperature, provider, true, currentMessages);
            } catch (err) {
                throw err;
            } finally {
                setIsThinking(false);
            }

            let toolLoopCount = 0;
            while (true) {
                toolLoopCount += 1;
                if (toolLoopCount > 8) {
                    response = `${response ? `${response}\n\n` : ''}작업이 여러 단계로 계속 이어지고 있어 여기서 중단했습니다. 다음 단계가 더 필요하면 이어서 진행하겠습니다.`;
                    break;
                }

                const parsedToolCall = parseToolCallFromResponse(response);
                if (parsedToolCall) {
                    const { raw, toolName, commandText, parsedKeys, toolArgs } = parsedToolCall;
                    const commandPolicy = classifyCommand(commandText);
                    const windowsCmdSyntaxError = toolName === 'execute_command' && window.navigator.platform.toLowerCase().includes('win')
                        ? detectWindowsCmdSyntax(commandText)
                        : null;

                    // Filter out the tool call from the response to prevent loops and show only final text
                    response = response.replace(raw, '').trim();

                    if (windowsCmdSyntaxError) {
                        commandIntercepted = true;
                        setMessages(prev => [...prev, {
                            role: 'system',
                            content: `${response ? `${response}\n\n` : ''}Windows에서는 PowerShell 문법만 사용해야 합니다. ${windowsCmdSyntaxError}`,
                        }]);
                        response = '';
                        break;
                    }

                    if (toolName === 'execute_command' && commandPolicy.status === 'blocked') {
                        commandIntercepted = true;
                        setMessages(prev => [...prev, {
                            role: 'system',
                            content: response || '위험한 명령이 감지되어 실행되지 않았습니다.',
                            commandRequest: {
                                status: 'blocked',
                                command: commandText,
                                reason: commandPolicy.reason || '차단 규칙과 일치했습니다.',
                            },
                        }]);
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
                        setMessages(prev => [...prev, {
                            role: 'system',
                            content: response || '이 명령은 실행 전에 사용자 승인이 필요합니다.',
                            commandRequest: {
                                status: 'approval',
                                command: commandText,
                                reason: commandPolicy.reason || '사용자 승인이 필요합니다.',
                            },
                        }]);
                        response = '';
                        break;
                    }

                    setMessages(prev => [...prev, { role: 'system', content: `🔧 Executing ${toolName}...` }]);

                    try {
                        const result = toolName === 'send_keys'
                            ? (handleAppLevelSendKeys(parsedKeys) ?? await CallTool(toolName, toolArgs))
                            : await CallTool(toolName, toolArgs);
                        console.log(`[MCP] Tool ${toolName} result:`, result);
                        const toolResultForUi: Message = {
                            role: 'tool',
                            name: toolName,
                            content: `${toolName === 'send_keys' ? 'Keys' : 'Command'}: \`${commandText}\`\n\nStatus: ${result}`
                        };
                        setMessages(prev => [...prev, toolResultForUi]);
                        if (shouldContinueAfterToolExecution(toolName)) {
                            ensureAssistantPlaceholder();
                            setCurrentThinking('');
                            setIsThinking(true);
                            response = await continueAfterToolExecution(
                                toolName,
                                toolArgs,
                                result,
                                loopHistory,
                                baseSystemPrompt,
                                response,
                            );
                            setIsThinking(false);
                        } else {
                            appendToolResultToHistory(loopHistory, toolName, toolArgs, result);
                            ensureAssistantPlaceholder();
                            setCurrentThinking('');
                            setIsThinking(true);
                            response = await inspectTerminalIfNeeded(
                                toolName,
                                commandText,
                                loopHistory,
                                baseSystemPrompt,
                                response,
                            );
                            setIsThinking(false);
                        }
                    } catch (err) {
                        response = `Error calling tool ${toolName}: ${err}`;
                        break;
                    }
                } else {
                    break;
                }
            }

            if (!response && !currentThinking && !commandIntercepted) {
                response = "죄송합니다. 응답을 생성하지 못했습니다. 설정을 확인하거나 다시 시도해 주세요.";
            }

            if (commandIntercepted) {
                setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant' && !last.content) {
                        updated.pop();
                    }
                    return updated;
                });
                return;
            }

            setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === 'assistant') {
                    last.content = response;
                    last.reasoning = currentThinking;
                }
                return updated;
            });
        } catch (error: any) {
            console.error("[LLM] Error in sendMessage:", error);
            setMessages(prev => [...prev, { role: 'system', content: `❌ LLM Request Failed: ${error.message || error}` }]);
        } finally {
            setIsLoading(false);
            setIsThinking(false);
        }
    };

    const handleStop = async () => {
        await StopLLMResponse();
        setIsLoading(false);
        setIsThinking(false);
    };

    const clearMessages = () => {
        setMessages([{
            role: 'assistant',
            content: `<analysis>System Lifecycle: Reset Success</analysis>
<progress title="DKST Terminal Assistant: New Session" description="System is ready for your next request.">
1. Conversation history cleared
2. Memory buffer released
</progress>
대화 기록이 초기화되었습니다. 무엇을 도와드릴까요?`
        }]);
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
                                <div key={tab.id} className={`tab-item ${activeTabId === tab.id ? 'active' : ''}`} onClick={() => setActiveTabId(tab.id)}>
                                    {tab.name}
                                    {tabs.length > 1 && <span className="close-tab" onClick={(e) => removeTab(e, tab.id)}>×</span>}
                                </div>
                            ))}
                            <button className="add-tab-btn" onClick={addTab} title="New Tab">+</button>
                        </div>
                        <div className="header-actions">
                            <button className="icon-btn" title="Settings" onClick={() => {
                                setIsSettingsOpen(true);
                                if (provider === 'LM Studio' && availableModels.length === 0) {
                                    handleFetchModels();
                                }
                            }}>
                                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                            </button>
                        </div>
                    </div>
                    <div className="terminal-container-wrapper">
                        {tabs.map(tab => (
                            <div key={tab.id} className={`terminal-container ${activeTabId === tab.id ? 'active' : ''}`} ref={el => terminalContainersRef.current[tab.id] = el}></div>
                        ))}
                    </div>
                </div>

                <div className="pane-resizer" onMouseDown={() => { isResizing.current = true; document.body.style.cursor = 'col-resize'; }}></div>

                <div className="chat-pane" style={{ width: `${chatWidth}px` }}>
                    <div className="pane-header">
                        <div className="header-title">Assistant</div>
                        <div className="header-actions">
                            <button className="icon-btn" title="Clear History" onClick={clearMessages}>
                                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                            </button>
                        </div>
                    </div>
                    <div className="chat-content" style={{ fontSize: `${chatFontSize}px`, fontFamily: chatFontFamily }}>
                        <div className="message-list">
                            {messages.map((m, i) => (
                                <div key={i} className={`message ${m.role}`}>
                                    <div className="message-label">
                                        {m.role === 'user' ? 'YOU' : m.role === 'tool' ? 'TOOL' : m.role === 'system' ? 'SYSTEM' : ASSISTANT_DISPLAY_NAME.toUpperCase()}
                                    </div>
                                    {m.role === 'assistant' && (
                                        <>
                                            {/* Historical reasoning */}
                                            {m.reasoning && !isLoading && (
                                                <ReasoningBox content={m.reasoning} isThinking={false} />
                                            )}
                                            {/* Active reasoning for the last message */}
                                            {i === messages.length - 1 && isLoading && (currentThinking || isThinking) && (
                                                <ReasoningBox content={currentThinking} isThinking={isThinking} />
                                            )}
                                            {i === messages.length - 1 && isLoading && provider === 'LM Studio' && (
                                                <LLMProgressCard progress={llmProgress} />
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
                                                        <button className="approval-cancel-btn" onClick={() => handleCommandApprovalDecision(false)}>취소</button>
                                                        <button className="approval-run-btn" onClick={() => handleCommandApprovalDecision(true)}>실행</button>
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
                    <div className="chat-input-area">
                        <div className="input-wrapper" style={{ fontSize: `${chatFontSize}px`, fontFamily: chatFontFamily }}>
                            <textarea
                                className="chat-input"
                                placeholder={t('chatPlaceholder')}
                                value={inputText}
                                onChange={e => setInputText(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                                {...textAssistOffProps}
                            ></textarea>
                            {isLoading ? (
                                <button className="stop-btn" onClick={handleStop} title="정지" aria-label="정지">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                                        <rect x="6" y="6" width="12" height="12" rx="1.5"></rect>
                                    </svg>
                                </button>
                            ) : (
                                <button className="send-btn" onClick={sendMessage} title="전송" aria-label="전송">
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
                                            <input type="number" value={maxTokens} onChange={e => setMaxTokens(Number(e.target.value))} />
                                            <span className="settings-hint">{t('tokensHint')}</span>
                                        </div>
                                        <div className="settings-field"><label>{t('temperature')}</label><input type="number" step="0.1" value={temperature} onChange={e => setTemperature(Number(e.target.value))} /></div>
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
                                            title="MCP 설정 문서 보기"
                                            aria-label="MCP 설정 문서 보기"
                                        >
                                            ?
                                        </button>
                                    </div>
                                    <div className="settings-grid">
                                        <div className="settings-field">
                                            <label>{t('mcpPort')}</label>
                                            <input type="number" value={mcpPort} onChange={e => setMcpPort(Number(e.target.value))} />
                                        </div>
                                        <div className="settings-field">
                                            <label>{t('mcpLabel')}</label>
                                            <input type="text" value={mcpLabel} onChange={e => setMcpLabel(e.target.value)} {...textAssistOffProps} />
                                            <span style={{ fontSize: '10px', opacity: 0.5 }}>LM Studio의 mcp.json에 설정할 라벨입니다.</span>
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
