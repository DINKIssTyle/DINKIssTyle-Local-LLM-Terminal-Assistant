/*
    Created by DINKIssTyle on 2026.
    Copyright (C) 2026 DINKI'ssTyle. All rights reserved.
*/

import { useState, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './App.css';
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
        .replace(/<artifact[^>]*>([\s\S]*?)<\/artifact>/gi, '$1')
        .replace(/```[\s\S]*?```/g, '[code block]')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
        .replace(/[*_`>#-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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
            .filter(Boolean)
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
        const items = content
            .split('\n')
            .map((line: string) => line.trim())
            .filter(Boolean)
            .map((line: string, index: number) => {
                const cleaned = line.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '');
                return `<div class="progress-item"><span class="progress-num">${index + 1}</span><span>${renderInlineMarkdown(cleaned)}</span></div>`;
            })
            .join('');

        return stash(`<section class="message-block progress-block">
            <div class="progress-header"><span>Working Step</span><span class="progress-meta">Progress</span></div>
            <div class="progress-list">${items}</div>
        </section>`);
    });

    html = html.replace(/<artifact title="([^"]*)" description="([^"]*)" type="([^"]*)">([^<]*)<\/artifact>/gi, (_, title, desc, type, path) => {
        return stash(`<section class="artifact-card">
            <div class="artifact-header">
                <div class="artifact-title">${renderInlineMarkdown(title)}</div>
                <button class="open-btn" onclick="window.dispatchEvent(new CustomEvent('open-artifact', {detail: '${escapeHtml(path.trim())}'}))">Open</button>
            </div>
            <div class="artifact-type">${renderInlineMarkdown(type)}</div>
            <div class="artifact-desc">${renderInlineMarkdown(desc)}</div>
        </section>`);
    });

    html = html.replace(/>>>\s*EXECUTE_COMMAND:\s*"([\s\S]*?)"\s*<<</g, (_, command) => {
        return stash(`<section class="message-block command-block">
            <div class="command-header">
                <span>Run In Terminal</span>
                <span class="progress-meta">Action</span>
            </div>
            <div class="command-body"><code>${escapeHtml(command.trim())}</code></div>
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

interface PendingCommandApproval {
    command: string;
    toolName: string;
    toolArgs: string;
    historyToSend: Message[];
    baseSystemPrompt: string;
    responseSansCommand: string;
}

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

    // Settings with persistence
    const [apiUrl, setApiUrl] = useState(() => localStorage.getItem('apiUrl') || 'http://localhost:1234/v1');
    const [apiKey, setApiKey] = useState(() => localStorage.getItem('apiKey') || '');
    const [modelName, setModelName] = useState(() => localStorage.getItem('modelName') || 'local-model');
    const [maxTokens, setMaxTokens] = useState(() => Number(localStorage.getItem('maxTokens')) || 4096);
    const [temperature, setTemperature] = useState(() => Number(localStorage.getItem('temperature')) || 0.7);
    const [provider, setProvider] = useState(() => localStorage.getItem('provider') || 'LM Studio');

    // Terminal Settings with persistence
    const [termFontSize, setTermFontSize] = useState(() => clampTerminalFontSize(Number(localStorage.getItem('termFontSize')) || 14));
    const [termFontFamily, setTermFontFamily] = useState(() => localStorage.getItem('termFontFamily') || '"Cascadia Code", Menlo, Monaco, "Courier New", monospace');
    const [termForeground, setTermForeground] = useState(() => localStorage.getItem('termForeground') || '#c0caf5');
    const [termBackground, setTermBackground] = useState(() => localStorage.getItem('termBackground') || '#000000');

    // Assistant Settings with persistence
    const [chatFontSize, setChatFontSize] = useState(() => Number(localStorage.getItem('chatFontSize')) || 14);
    const [chatFontFamily, setChatFontFamily] = useState(() => {
        const saved = localStorage.getItem('chatFontFamily');
        if (!saved || saved.includes("Inter")) return 'system-ui, -apple-system, sans-serif';
        return saved;
    });
    const [chatWidth, setChatWidth] = useState(() => Number(localStorage.getItem('chatWidth')) || 450);
    const [mcpPort, setMcpPort] = useState(() => Number(localStorage.getItem('mcpPort')) || 8080);
    const [mcpLabel, setMcpLabel] = useState(() => localStorage.getItem('mcpLabel') || 'dinkisstyle-gateway');
    const [blockedCommandPatterns, setBlockedCommandPatterns] = useState(() => localStorage.getItem('blockedCommandPatterns') || DEFAULT_BLOCKED_COMMAND_PATTERNS);
    const [approvalCommandPatterns, setApprovalCommandPatterns] = useState(() => localStorage.getItem('approvalCommandPatterns') || DEFAULT_APPROVAL_COMMAND_PATTERNS);
    const isResizing = useRef(false);

    // MCP Settings with persistence
    const [enabledTools, setEnabledTools] = useState<string[]>(() => {
        try {
            const saved = localStorage.getItem('enabledTools');
            return saved ? JSON.parse(saved) : ['search_web', 'read_web_page', 'get_current_time', 'execute_command'];
        } catch (e) {
            console.error("Error parsing enabledTools", e);
            return ['search_web', 'read_web_page', 'get_current_time', 'execute_command'];
        }
    });
    const [pendingApproval, setPendingApproval] = useState<PendingCommandApproval | null>(null);

    useEffect(() => {
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
    }, [apiUrl, apiKey, modelName, maxTokens, temperature, provider, termFontSize, termFontFamily, termForeground, termBackground, chatFontSize, chatFontFamily, chatWidth, mcpPort, mcpLabel, blockedCommandPatterns, approvalCommandPatterns, enabledTools]);

    const handleSaveSettings = () => {
        UpdateMCPSettings(mcpPort, mcpLabel);
        setIsSettingsOpen(false);
    };

    useEffect(() => {
        SetActiveTab(activeTabId);
    }, [activeTabId]);

    const [availableTools, setAvailableTools] = useState<any[]>([]);
    const [messages, setMessages] = useState<Message[]>([
        {
            role: 'assistant',
            content: `<analysis>System Initialization</analysis>
<progress title="Welcome to DKST Terminal Assistant" description="I am ready to assist you with terminal tasks and coding.">
1. Terminal connected to active tab
2. MCP tools loaded and ready
3. Markdown renderer initialized
</progress>
안녕하세요! **DKST Terminal Assistant**입니다. 무엇을 도와드릴까요?`
        }
    ]);
    const [inputText, setInputText] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const chatEndRef = useRef<HTMLDivElement>(null);
    const [currentThinking, setCurrentThinking] = useState('');
    const [isThinking, setIsThinking] = useState(false);

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
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            window.removeEventListener('open-artifact', (e: any) => { });
            fitTimeoutsRef.current.forEach(timeout => window.clearTimeout(timeout));
        };
    }, []);

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

        return () => {
            unoffChunk();
            unoffThinking();
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
        const newId = String(Date.now());
        setTabs([...tabs, { id: newId, name: `Tab ${tabs.length + 1}` }]);
        setActiveTabId(newId);
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

    const classifyCommand = (command: string): { status: 'allow' | 'blocked' | 'approval'; reason?: string } => {
        const normalized = command.toLowerCase();
        const blockedMatch = parseSafetyPatterns(blockedCommandPatterns).find(pattern => normalized.includes(pattern.toLowerCase()));
        if (blockedMatch) {
            return {
                status: 'blocked',
                reason: `차단 규칙 "${blockedMatch}" 과 일치하여 앱이 실행을 막았습니다.`,
            };
        }

        const approvalMatch = parseSafetyPatterns(approvalCommandPatterns).find(pattern => normalized.includes(pattern.toLowerCase()));
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
        const toolRole: 'tool' | 'user' = (provider === 'OpenAI') ? 'tool' : 'user';
        const toolContent = (toolRole === 'user') ? `[Tool Response from ${toolName}]: ${result}` : result;
        const toolResultMsg: Message = { role: toolRole, content: toolContent, name: toolName };

        historyToSend.push({ role: 'assistant', content: `[TOOL: ${toolName} ${toolArgs}]` });
        historyToSend.push(toolResultMsg);

        let nextResponse = '';
        if (responseSansCommand) {
            nextResponse = responseSansCommand;
        }

        const llmMessages = buildLLMMessages(historyToSend, baseSystemPrompt);
        nextResponse = await FetchLLMResponse(apiUrl, apiKey, modelName, maxTokens, temperature, provider, true, llmMessages);
        return nextResponse;
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

        try {
            const result = await CallTool(request.toolName, request.toolArgs);
            setMessages(prev => [...prev, {
                role: 'tool',
                name: request.toolName,
                content: `Command: \`${request.command}\`\n\nResult:\n\`\`\`\n${result}\n\`\`\``
            }]);

            const response = await continueAfterToolExecution(
                request.toolName,
                request.toolArgs,
                result,
                [...request.historyToSend],
                request.baseSystemPrompt,
                request.responseSansCommand,
            );

            setMessages(prev => [...prev, { role: 'assistant', content: response || '명령 실행은 완료되었지만 후속 응답이 비어 있습니다.' }]);
        } catch (error: any) {
            setMessages(prev => [...prev, { role: 'system', content: `❌ 승인된 명령 실행 실패: ${error.message || error}` }]);
        } finally {
            setIsLoading(false);
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

            const baseSystemPrompt = `You are ${mcpLabel}, a professional AI engineer. 
1. UI: Use <analysis>, <progress>, and <artifact> blocks when they add value. Keep answers compact and readable in a narrow side chat.
2. SCREEN AWARENESS: You receive SCREEN_CONTEXT describing what is visible in the app right now. When the user asks about "this", "above", "on screen", terminal output, or chat content, use SCREEN_CONTEXT first. If the context is insufficient, say exactly what is missing.
3. TOOLS: To run a terminal command, YOU MUST output this EXACT line:
   >>> EXECUTE_COMMAND: "YOUR_COMMAND" <<<
   
Example: To check the home folder, output:
>>> EXECUTE_COMMAND: "cd ~ && ls" <<<

ALWAYS use the tool when the user asks for terminal actions.
4. STYLE: Aim for a VS Code / Antigravity side-panel tone with minimal vertical waste.
Current OS: ${window.navigator.platform}`;

            const historyToSend = newMessages.filter((msg, idx) => {
                if (idx === 0 && msg.role === 'assistant') return false;
                return true;
            });

            let currentMessages: any[] = buildLLMMessages(historyToSend, baseSystemPrompt);
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

            // Ultra-simple regex for local LLMs: >>> EXECUTE_COMMAND: "cmd" <<<
            const toolRegex = />>>\s*EXECUTE_COMMAND:\s*"([\s\S]*?)"\s*<<</;

            while (true) {
                const match = response.match(toolRegex);
                if (match) {
                    const toolName = "execute_command";
                    const toolArgs = JSON.stringify({ command: match[1] });
                    const commandText = match[1];
                    const commandPolicy = classifyCommand(commandText);

                    // Filter out the tool call from the response to prevent loops and show only final text
                    response = response.replace(match[0], '').trim();

                    if (commandPolicy.status === 'blocked') {
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

                    if (commandPolicy.status === 'approval') {
                        commandIntercepted = true;
                        setPendingApproval({
                            command: commandText,
                            toolName,
                            toolArgs,
                            historyToSend: [...historyToSend],
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
                        const result = await CallTool(toolName, toolArgs);
                        console.log(`[MCP] Tool ${toolName} result:`, result);
                        const toolResultForUi: Message = {
                            role: 'tool',
                            name: toolName,
                            content: `Command: \`${commandText}\`\n\nResult:\n\`\`\`\n${result}\n\`\`\``
                        };
                        setMessages(prev => [...prev, toolResultForUi]);
                        response = await continueAfterToolExecution(
                            toolName,
                            toolArgs,
                            result,
                            historyToSend,
                            baseSystemPrompt,
                            response,
                        );
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
                            <button className="icon-btn" title="Settings" onClick={() => setIsSettingsOpen(true)}>
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
                        <div className="input-wrapper">
                            <textarea
                                className="chat-input"
                                placeholder="메시지를 입력하세요..."
                                value={inputText}
                                onChange={e => setInputText(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
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
                                <h3>Configuration</h3>
                            </div>
                            <div className="settings-tabs-content">
                                <div className="settings-section">
                                    <h4>LLM Configuration</h4>
                                    <div className="settings-grid">
                                        <div className="settings-field full">
                                            <label>Server URL</label>
                                            <input type="text" value={apiUrl} onChange={e => setApiUrl(e.target.value)} placeholder="http://127.0.0.1:1234/v1" />
                                        </div>
                                        <div className="settings-field full">
                                            <label>API Key (Optional)</label>
                                            <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="OpenAI or Local key" />
                                        </div>
                                        <div className="settings-field full">
                                            <label>Model Key</label>
                                            <input type="text" value={modelName} onChange={e => setModelName(e.target.value)} />
                                        </div>
                                        <div className="settings-field"><label>Max Tokens</label><input type="number" value={maxTokens} onChange={e => setMaxTokens(Number(e.target.value))} /></div>
                                        <div className="settings-field"><label>Temperature</label><input type="number" step="0.1" value={temperature} onChange={e => setTemperature(Number(e.target.value))} /></div>
                                        <div className="settings-field">
                                            <label>LLM Provider</label>
                                            <select value={provider} onChange={e => setProvider(e.target.value)}>
                                                <option>LM Studio</option><option>OpenAI</option><option>Ollama</option><option>Custom</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>
                                <div className="settings-section">
                                    <h4>Assistant Appearance</h4>
                                    <div className="settings-grid">
                                        <div className="settings-field"><label>FontSize</label><input type="number" value={chatFontSize} onChange={e => setChatFontSize(Number(e.target.value))} /></div>
                                        <div className="settings-field"><label>FontFamily</label><input type="text" value={chatFontFamily} onChange={e => setChatFontFamily(e.target.value)} /></div>
                                    </div>
                                </div>
                                <div className="settings-section">
                                    <h4>Terminal Appearance</h4>
                                    <div className="settings-grid">
                                        <div className="settings-field"><label>FontSize</label><input type="number" min="10" max="24" value={termFontSize} onChange={e => setTermFontSize(clampTerminalFontSize(Number(e.target.value)))} /></div>
                                        <div className="settings-field"><label>FontFamily</label><input type="text" value={termFontFamily} onChange={e => setTermFontFamily(e.target.value)} /></div>
                                        <div className="settings-field"><label>Foreground</label><input type="color" value={termForeground} onChange={e => setTermForeground(e.target.value)} /></div>
                                        <div className="settings-field"><label>Background</label><input type="color" value={termBackground} onChange={e => setTermBackground(e.target.value)} /></div>
                                    </div>
                                </div>
                                <div className="settings-section">
                                    <h4>MCP Gateway Configuration</h4>
                                    <div className="settings-grid">
                                        <div className="settings-field">
                                            <label>MCP Server Port</label>
                                            <input type="number" value={mcpPort} onChange={e => setMcpPort(Number(e.target.value))} />
                                        </div>
                                        <div className="settings-field">
                                            <label>MCP Server Label</label>
                                            <input type="text" value={mcpLabel} onChange={e => setMcpLabel(e.target.value)} />
                                            <span style={{ fontSize: '10px', opacity: 0.5 }}>LM Studio의 mcp.json에 설정할 라벨입니다.</span>
                                        </div>
                                    </div>
                                    <h4 style={{ marginTop: '20px' }}>Tool Management</h4>
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
                                    <h4>Command Safety</h4>
                                    <div className="settings-grid">
                                        <div className="settings-field full">
                                            <div className="settings-field-header">
                                                <label>Blocked Commands Patterns</label>
                                                <button className="mini-reset-btn" onClick={() => setBlockedCommandPatterns(DEFAULT_BLOCKED_COMMAND_PATTERNS)}>기본값</button>
                                            </div>
                                            <textarea
                                                className="settings-textarea"
                                                value={blockedCommandPatterns}
                                                onChange={e => setBlockedCommandPatterns(e.target.value)}
                                            />
                                            <span style={{ fontSize: '10px', opacity: 0.6 }}>한 줄에 하나씩 입력하세요. 일치하면 앱이 LLM 실행 전에 차단합니다.</span>
                                        </div>
                                        <div className="settings-field full">
                                            <div className="settings-field-header">
                                                <label>Approval Required Patterns</label>
                                                <button className="mini-reset-btn" onClick={() => setApprovalCommandPatterns(DEFAULT_APPROVAL_COMMAND_PATTERNS)}>기본값</button>
                                            </div>
                                            <textarea
                                                className="settings-textarea"
                                                value={approvalCommandPatterns}
                                                onChange={e => setApprovalCommandPatterns(e.target.value)}
                                            />
                                            <span style={{ fontSize: '10px', opacity: 0.6 }}>한 줄에 하나씩 입력하세요. 일치하면 채팅창에서 취소/실행 승인을 요청합니다.</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div className="settings-footer">
                                <button className="save-btn" onClick={handleSaveSettings}>Apply & Save</button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default App;
