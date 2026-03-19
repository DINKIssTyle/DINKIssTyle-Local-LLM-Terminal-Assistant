/*
    Created by DINKIssTyle on 2026.
    Copyright (C) 2026 DINKI'ssTyle. All rights reserved.
*/

import {useState, useEffect, useRef} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './App.css';
import { StartTerminal, WriteToTerminal, ResizeTerminal, FetchLLMResponse, CallTool, GetTools, StopTerminal, SetActiveTab, UpdateMCPSettings } from "../wailsjs/go/main/App";
import { EventsOn, EventsEmit } from "../wailsjs/runtime/runtime";

interface Message {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    name?: string;
}

interface Tab {
    id: string;
    name: string;
}

function App() {
    const terminalContainersRef = useRef<{ [id: string]: HTMLDivElement | null }>({});
    const xtermsRef = useRef<{ [id: string]: Terminal | null }>({});
    const fitAddonsRef = useRef<{ [id: string]: FitAddon | null }>({});
    
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
    const [isStreaming, setIsStreaming] = useState(() => localStorage.getItem('isStreaming') === 'true');

    // Terminal Settings with persistence
    const [termFontSize, setTermFontSize] = useState(() => Number(localStorage.getItem('termFontSize')) || 14);
    const [termFontFamily, setTermFontFamily] = useState(() => localStorage.getItem('termFontFamily') || '"Cascadia Code", Menlo, Monaco, "Courier New", monospace');
    const [termForeground, setTermForeground] = useState(() => localStorage.getItem('termForeground') || '#c0caf5');
    const [termBackground, setTermBackground] = useState(() => localStorage.getItem('termBackground') || '#000000');

    // Assistant Settings with persistence
    const [chatFontSize, setChatFontSize] = useState(() => Number(localStorage.getItem('chatFontSize')) || 14);
    const [chatFontFamily, setChatFontFamily] = useState(() => localStorage.getItem('chatFontFamily') || 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif');
    const [chatWidth, setChatWidth] = useState(() => Number(localStorage.getItem('chatWidth')) || 450);
    const [mcpPort, setMcpPort] = useState(() => Number(localStorage.getItem('mcpPort')) || 8080);
    const [mcpLabel, setMcpLabel] = useState(() => localStorage.getItem('mcpLabel') || 'dinkisstyle-gateway');
    const isResizing = useRef(false);

    // MCP Settings with persistence
    const [enabledTools, setEnabledTools] = useState<string[]>(() => {
        const saved = localStorage.getItem('enabledTools');
        return saved ? JSON.parse(saved) : ['search_web', 'read_web_page', 'get_current_time', 'execute_command'];
    });

    useEffect(() => {
        localStorage.setItem('apiUrl', apiUrl);
        localStorage.setItem('apiKey', apiKey);
        localStorage.setItem('modelName', modelName);
        localStorage.setItem('maxTokens', String(maxTokens));
        localStorage.setItem('temperature', String(temperature));
        localStorage.setItem('provider', provider);
        localStorage.setItem('isStreaming', String(isStreaming));
        localStorage.setItem('termFontSize', String(termFontSize));
        localStorage.setItem('termFontFamily', termFontFamily);
        localStorage.setItem('termForeground', termForeground);
        localStorage.setItem('termBackground', termBackground);
        localStorage.setItem('chatFontSize', String(chatFontSize));
        localStorage.setItem('chatFontFamily', chatFontFamily);
        localStorage.setItem('chatWidth', String(chatWidth));
        localStorage.setItem('mcpPort', String(mcpPort));
        localStorage.setItem('mcpLabel', mcpLabel);
        localStorage.setItem('enabledTools', JSON.stringify(enabledTools));
    }, [apiUrl, apiKey, modelName, maxTokens, temperature, provider, isStreaming, termFontSize, termFontFamily, termForeground, termBackground, chatFontSize, chatFontFamily, chatWidth, mcpPort, mcpLabel, enabledTools]);

    const handleSaveSettings = () => {
        UpdateMCPSettings(mcpPort, mcpLabel);
        setIsSettingsOpen(false);
    };

    useEffect(() => {
        SetActiveTab(activeTabId);
    }, [activeTabId]);

    const [availableTools, setAvailableTools] = useState<any[]>([]);
    const [messages, setMessages] = useState<Message[]>([
        { role: 'assistant', content: '안녕하세요! DKST Terminal Assistant입니다. 무엇을 도와드릴까요?' }
    ]);
    const [inputText, setInputText] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const chatEndRef = useRef<HTMLDivElement>(null);
    const [currentThinking, setCurrentThinking] = useState('');

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
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
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
        });

        return () => {
            unoffChunk();
            unoffThinking();
        };
    }, []);

    const scrollToBottom = () => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
            fitAddon.fit();

            xtermsRef.current[tab.id] = term;
            fitAddonsRef.current[tab.id] = fitAddon;

            term.onData(data => WriteToTerminal(tab.id, data));
            const unoff = EventsOn("terminal:data:" + tab.id, (data: string) => term.write(data));
            StartTerminal(tab.id);
            (term as any)._unoff = unoff;
        });

        const handleResize = () => {
            Object.values(fitAddonsRef.current).forEach(fit => fit?.fit());
            const term = xtermsRef.current[activeTabId];
            if (term) ResizeTerminal(activeTabId, term.cols, term.rows);
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [tabs]);

    useEffect(() => {
        Object.values(xtermsRef.current).forEach(term => {
            if (!term) return;
            term.options.fontSize = termFontSize;
            term.options.fontFamily = termFontFamily;
            term.options.theme = {
                background: termBackground,
                foreground: termForeground,
                cursor: '#7aa2f7',
                selectionBackground: '#3b4261',
            };
        });
        Object.values(fitAddonsRef.current).forEach(fit => fit?.fit());
    }, [termFontSize, termFontFamily, termBackground, termForeground]);

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

    const sendMessage = async () => {
        if (!inputText.trim() || isLoading) return;

        const userMessage: Message = { role: 'user', content: inputText };
        const newMessages = [...messages, userMessage];
        setMessages(newMessages);
        setInputText('');
        setIsLoading(true);
        setCurrentThinking('');

        try {
            const activeTools = availableTools.filter(t => enabledTools.includes(t.name));
            const systemPrompt = `You are a helpful terminal assistant named ${mcpLabel}. 
You have access to the following tools: ${JSON.stringify(activeTools)}.
To use a tool, you MUST respond with the following EXACT format:
[TOOL: tool_name {"arg1": "value"}]

Wait for the tool result before continuing your response.
Current OS: ${window.navigator.platform}`;

            const historyToSend = newMessages.filter((msg, idx) => {
                if (idx === 0 && msg.role === 'assistant') return false;
                return true;
            });

            let currentMessages: any[] = [{ role: 'system', content: systemPrompt }, ...historyToSend];
            let response = await FetchLLMResponse(apiUrl, apiKey, modelName, maxTokens, temperature, provider, isStreaming, currentMessages);
            
            // Robust regex to handle multi-line JSON (using [\s\S] for dotAll behavior)
            const toolRegex = /\[TOOL:\s*(\w+)\s*([\s\S]*?)\]/;
            
            while (true) {
                const match = response.match(toolRegex);
                if (match) {
                    const toolName = match[1];
                    const toolArgs = match[2].trim() || '{}';
                    
                    // Filter out the tool call from the response to prevent loops and show only final text
                    response = response.replace(match[0], '').trim();
                    
                    setMessages(prev => [...prev, { role: 'system', content: `🔧 Executing ${toolName}...` }]);
                    
                    try {
                        const result = await CallTool(toolName, toolArgs);
                        
                        // Map role: 'tool' to 'user' for local LLMs for better compatibility
                        const toolRole: 'tool' | 'user' = (provider === 'OpenAI') ? 'tool' : 'user';
                        const toolContent = (toolRole === 'user') ? `[Tool Response from ${toolName}]: ${result}` : result;
                        
                        const toolResultMsg: Message = { role: toolRole, content: toolContent, name: toolName };
                        
                        currentMessages.push({ role: 'assistant', content: `[TOOL: ${toolName} ${toolArgs}]` });
                        currentMessages.push(toolResultMsg);
                        
                        // Get next response after tool execution
                        response = await FetchLLMResponse(apiUrl, apiKey, modelName, maxTokens, temperature, provider, isStreaming, currentMessages);
                    } catch (err) {
                        response = `Error calling tool ${toolName}: ${err}`;
                        break;
                    }
                } else {
                    break;
                }
            }

            setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
            await FetchLLMResponse(apiUrl, apiKey, modelName, maxTokens, temperature, provider, isStreaming, currentMessages);
        } catch (error) {
            setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${error}` }]);
        } finally {
            setIsLoading(false);
            setCurrentThinking('');
        }
    };

    const clearMessages = () => {
        setMessages([{ role: 'assistant', content: '대화 기록이 초기화되었습니다.' }]);
    };

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
                                    {m.role === 'assistant' && i === messages.length - 1 && currentThinking && (
                                        <div className="thinking-block">
                                            <div className="thinking-header">Thinking...</div>
                                            <div className="thinking-content">{currentThinking}</div>
                                        </div>
                                    )}
                                    <div className="bubble">{m.content}</div>
                                </div>
                            ))}
                            {isLoading && (!messages[messages.length - 1] || (!messages[messages.length - 1].content && !currentThinking)) && (
                                <div className="message assistant loading"><div className="bubble">Thinking...</div></div>
                            )}
                            <div ref={chatEndRef} />
                        </div>
                    </div>
                    <div className="chat-input-area">
                        <textarea 
                            className="chat-input" 
                            placeholder="메시지를 입력하세요..." 
                            value={inputText} 
                            onChange={e => setInputText(e.target.value)} 
                            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                        ></textarea>
                        <button className="send-btn" onClick={sendMessage} disabled={isLoading}>{isLoading ? '...' : '전송'}</button>
                    </div>
                </div>

                {isSettingsOpen && (
                    <div className="settings-overlay" onClick={() => setIsSettingsOpen(false)}>
                        <div className="settings-modal" onClick={e => e.stopPropagation()}>
                            <div className="settings-header">
                                <h3>Configuration</h3>
                                <button className="close-icon-btn" onClick={() => setIsSettingsOpen(false)}>×</button>
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
                                        <div className="settings-field stream-field"><label>Streaming</label><input type="checkbox" checked={isStreaming} onChange={e => setIsStreaming(e.target.checked)} /></div>
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
                                        <div className="settings-field"><label>FontSize</label><input type="number" value={termFontSize} onChange={e => setTermFontSize(Number(e.target.value))} /></div>
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
                            </div>
                            <div className="settings-footer"><button className="save-btn" onClick={handleSaveSettings}>Apply & Save</button></div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default App;
