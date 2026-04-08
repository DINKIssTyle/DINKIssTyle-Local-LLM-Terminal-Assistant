export interface PromptHarnessMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    name?: string;
}

export interface PromptVisibleTool {
    name: string;
    description?: string;
    inputSchema?: {
        properties?: Record<string, unknown>;
        required?: string[];
    };
}

type TaskMemory = {
    request: string;
    stage: 'plan' | 'execute' | 'inspect' | 'finalize';
    recentRequests: string[];
    planItems: string[];
    stepResults: string[];
    latestEvidence: string[];
    draftResponse: string;
};

type PromptHarnessDeps = {
    stripMarkupForContext: (value: string) => string;
    stripToolCallMarkup: (value: string) => string;
    parseToolCallFromResponse: (value: string) => { toolName?: string } | null;
    extractStructuredListItems: (value: string) => Array<{ text: string }>;
    isSyntheticToolResponseContent: (value: string) => boolean;
    buildScreenContext: (history: PromptHarnessMessage[]) => string;
};

type BuildLLMMessagesArgs = {
    history: PromptHarnessMessage[];
    baseSystemPrompt: string;
    includeScreenContext?: boolean;
    deps: PromptHarnessDeps;
};

type BuildBaseSystemPromptArgs = {
    mcpLabel: string;
    currentOS: string;
    currentWorkingDirectory: string;
    complexRequest: boolean;
    availableTools: PromptVisibleTool[];
    globalUserPrompt: string;
};

const SCREEN_CONTEXT_KEYWORDS = /화면|스크린|보이는|visible|ui|layout|버튼|입력창|chat|대화|terminal|터미널|prompt|프롬프트|nano|pico|vim|editor|편집기|pane|패널/i;
const TASK_MEMORY_REQUEST_LIMIT = 3;
const TASK_MEMORY_PLAN_LIMIT = 6;
const TASK_MEMORY_STEP_LIMIT = 6;
const TASK_MEMORY_EVIDENCE_LIMIT = 2;
const TASK_MEMORY_RECENT_MESSAGE_LIMIT = 6;

const clampText = (value: string, maxLength: number): string => {
    const normalized = value.trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength).trimEnd()}...`;
};

export const clampPromptTextFromEnd = (value: string, maxLength: number): string => {
    const normalized = value.trim();
    if (normalized.length <= maxLength) return normalized;
    return `...${normalized.slice(normalized.length - maxLength).trimStart()}`;
};

const extractTagContents = (value: string, tagName: string, deps: PromptHarnessDeps): string[] => {
    const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
    const matches: string[] = [];
    let match: RegExpExecArray | null = null;

    while ((match = regex.exec(value)) !== null) {
        const content = deps.stripMarkupForContext(match[1] || '');
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

const getMeaningfulUserHistory = (history: PromptHarnessMessage[], deps: PromptHarnessDeps): PromptHarnessMessage[] => (
    history.filter(message => message.role === 'user' && message.content.trim() && !deps.isSyntheticToolResponseContent(message.content))
);

const inferTaskStage = (history: PromptHarnessMessage[], deps: PromptHarnessDeps): TaskMemory['stage'] => {
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        const content = message.content.trim();
        if (!content) continue;

        if (message.role === 'tool') return 'inspect';
        if (message.role === 'user') return 'plan';
        if (message.role === 'assistant') {
            return deps.parseToolCallFromResponse(content) ? 'execute' : 'finalize';
        }
    }

    return 'plan';
};

const summarizeToolContentForMemory = (message: PromptHarnessMessage, deps: PromptHarnessDeps): string => {
    const normalized = deps.stripMarkupForContext(message.content);
    if (!normalized) {
        return message.name ? `${message.name}: (empty result)` : '(empty result)';
    }

    const commandMatch = normalized.match(/Command:\s*`?([^`\n]+)`?/i);
    const statusMatch = normalized.match(/Status:\s*([\s\S]*)$/i);
    const commandText = commandMatch?.[1]?.trim();
    const statusText = statusMatch ? clampText(deps.stripMarkupForContext(statusMatch[1]), 120) : clampText(normalized, 120);
    const toolName = message.name || 'tool';

    if (commandText) {
        if (statusText === `Sent to terminal: ${commandText}`) {
            return `${toolName}: ${commandText}`;
        }
        return `${toolName}: ${commandText} -> ${statusText}`;
    }

    return `${toolName}: ${statusText}`;
};

const summarizeMessageForMemory = (message: PromptHarnessMessage, deps: PromptHarnessDeps): string => {
    if (message.role === 'tool') {
        return summarizeToolContentForMemory(message, deps);
    }

    const normalized = deps.stripToolCallMarkup(deps.stripMarkupForContext(message.content));
    if (!normalized) return '';

    if (message.role === 'assistant') {
        return clampText(normalized, 220);
    }

    if (message.role === 'system') {
        return clampText(normalized, 180);
    }

    return clampText(normalized, 200);
};

const collectPlanItems = (history: PromptHarnessMessage[], deps: PromptHarnessDeps): string[] => {
    const collected: string[] = [];

    for (const message of history) {
        if (message.role !== 'assistant') continue;

        const sections = [
            ...extractTagContents(message.content, 'tasklist', deps),
            ...extractTagContents(message.content, 'execution_plan', deps),
            ...extractTagContents(message.content, 'progress', deps),
        ];

        for (const section of sections) {
            const items = deps.extractStructuredListItems(section);
            for (const item of items) {
                const text = clampText(deps.stripMarkupForContext(item.text), 140);
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

const buildTaskMemory = (history: PromptHarnessMessage[], deps: PromptHarnessDeps): TaskMemory => {
    const meaningfulUsers = getMeaningfulUserHistory(history, deps);
    const recentRequests = meaningfulUsers
        .slice(-TASK_MEMORY_REQUEST_LIMIT)
        .map(message => clampText(deps.stripMarkupForContext(message.content), 180));
    const request = recentRequests[recentRequests.length - 1] || '';

    const planItems = collectPlanItems(history, deps);
    const stepResults = dedupePreserveOrder(history
        .filter(message => message.role === 'tool' || (message.role === 'assistant' && !deps.parseToolCallFromResponse(message.content) && message.content.trim()))
        .map(message => summarizeMessageForMemory(message, deps))
        .filter(Boolean)
    ).slice(-TASK_MEMORY_STEP_LIMIT);

    const latestEvidence = dedupePreserveOrder(history
        .filter(message => {
            if (message.role === 'tool') return true;
            if (message.role === 'user' && /\[Latest user request\]/.test(message.content)) return true;
            return false;
        })
        .map(message => summarizeMessageForMemory(message, deps))
        .filter(Boolean)
    ).slice(-TASK_MEMORY_EVIDENCE_LIMIT);

    const latestAssistant = [...history]
        .reverse()
        .find(message => message.role === 'assistant' && !deps.parseToolCallFromResponse(message.content) && deps.stripToolCallMarkup(message.content).trim());
    const draftResponse = latestAssistant ? clampText(deps.stripToolCallMarkup(deps.stripMarkupForContext(latestAssistant.content)), 180) : '';
    const finalDraftResponse = stepResults.includes(draftResponse) ? '' : draftResponse;

    return {
        request,
        stage: inferTaskStage(history, deps),
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

const buildCompactHistory = (history: PromptHarnessMessage[], deps: PromptHarnessDeps): PromptHarnessMessage[] => {
    return history
        .filter((message, index) => {
            if (index === 0 && message.role === 'assistant') return false;
            if (message.role === 'system' && /^🔧 Executing /.test(message.content.trim())) return false;
            if (message.role === 'assistant' && !deps.stripToolCallMarkup(deps.stripMarkupForContext(message.content)).trim()) return false;
            return Boolean(message.content.trim());
        })
        .slice(-TASK_MEMORY_RECENT_MESSAGE_LIMIT)
        .map((message) => {
            const maxLength = message.role === 'tool' ? 220 : message.role === 'assistant' ? 240 : 180;
            return {
                ...message,
                content: clampPromptTextFromEnd(message.content, maxLength),
            };
        });
};

export const buildCompactVisibleChat = (history: PromptHarnessMessage[], deps: Pick<PromptHarnessDeps, 'isSyntheticToolResponseContent' | 'stripMarkupForContext'>): string => {
    return history
        .filter(message => !deps.isSyntheticToolResponseContent(message.content))
        .slice(-2)
        .map(message => {
            const roleLabel = message.role === 'user' ? 'U' : message.role === 'assistant' ? 'A' : message.role === 'tool' ? 'T' : 'S';
            return `${roleLabel}: ${clampText(deps.stripMarkupForContext(message.content) || '(empty)', 120)}`;
        })
        .join('\n');
};

export const shouldAttachScreenContext = (history: PromptHarnessMessage[], deps: Pick<PromptHarnessDeps, 'isSyntheticToolResponseContent' | 'parseToolCallFromResponse'>): boolean => {
    const latestUser = [...history]
        .reverse()
        .find(message => message.role === 'user' && message.content.trim() && !deps.isSyntheticToolResponseContent(message.content));
    const latestRequest = latestUser?.content || '';
    if (SCREEN_CONTEXT_KEYWORDS.test(latestRequest)) return true;

    const latestAssistant = [...history].reverse().find(message => message.role === 'assistant' && message.content.trim());
    if (latestAssistant && deps.parseToolCallFromResponse(latestAssistant.content)?.toolName === 'send_keys') {
        return true;
    }

    return false;
};

export const shouldUseComplexTaskMode = (request: string): boolean => {
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

const buildTaskWorkflowPrompt = (complexRequest: boolean): string => {
    if (!complexRequest) return '';

    return `
5. COMPLEX TASK MODE: The app already suspects this request may be complex, but you must still decide this yourself from the user's meaning, not from keywords or UI language. Before responding, quickly classify the request as either:
   - QUICK RESPONSE: a simple answer, brief explanation, or single obvious action that does not need planning
   - PLANNED TASK: work that needs multiple steps, implementation, investigation, refactoring, review, or coordination
   Only use task-oriented structure when it is truly a PLANNED TASK.
6. COMPLEX TASK FORMAT: For a PLANNED TASK, the first substantial assistant response may include these blocks in order when they add value:
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
7. COMPLEX TASK BEHAVIOR: If it is a QUICK RESPONSE, answer directly and do not create a task list, execution plan, or runbook framing. If it is a PLANNED TASK, do not only propose a plan. Actually carry out the work, keep the task list aligned with the work performed, and finish with a completion report.`;
};

const renderAvailableToolsForPrompt = (tools: PromptVisibleTool[]): string => {
    if (!tools.length) {
        return 'AVAILABLE_TOOLS:\n- (none)';
    }

    const lines = tools.map((tool) => {
        const schema = tool.inputSchema;
        const propertyNames = Object.keys(schema?.properties || {});
        const rawRequired = schema?.required;
        const required = Array.isArray(rawRequired) ? rawRequired : [];
        const argsText = propertyNames.length
            ? ` args: ${propertyNames.map((name) => `${name}${required.includes(name) ? '*' : ''}`).join(', ')}`
            : ' args: none';
        return `- ${tool.name}: ${(tool.description || '').trim()}${argsText}`;
    });

    lines.push('- Prefer search_web for current/latest internet information when it is available.');
    lines.push('- Use read_web_page only for a specific URL or when the user explicitly asks to inspect a page.');

    return `AVAILABLE_TOOLS:\n${lines.join('\n')}`;
};

export const getPromptVisibleTools = (
    tools: PromptVisibleTool[],
    enabledTools: string[],
    internalOnlyToolNames: ReadonlySet<string>,
): PromptVisibleTool[] => (
    tools.filter(tool => enabledTools.includes(tool.name) && !internalOnlyToolNames.has(tool.name))
);

export const buildBaseSystemPrompt = (args: BuildBaseSystemPromptArgs): string => {
    const trimmedGlobalUserPrompt = args.globalUserPrompt.trim();
    const globalUserPromptSection = trimmedGlobalUserPrompt
        ? `

5. GLOBAL USER PROMPT:
Treat this as persistent user preference/context unless it conflicts with safety, exact tool syntax, or the current request.
[BEGIN_GLOBAL_USER_PROMPT]
${trimmedGlobalUserPrompt}
[END_GLOBAL_USER_PROMPT]`
        : '';

    return `You are ${args.mcpLabel}, a professional AI engineer. 
1. Keep answers compact for a narrow side chat. First decide whether the user's request needs a quick direct response or a planned multi-step task. Use <analysis>, <progress>, and <artifact> only when helpful.
2. SCREEN_CONTEXT is only for visible UI/terminal/chat state. Do not use it as proof for files, paths, counts, command output, or other verifiable system facts when tools can check them.
3. Tool syntax is strict. Use exactly one structured format for all tool calls:
   - Terminal command: <execute_command>{"command":"YOUR_COMMAND"}</execute_command>
   - Terminal keys: <send_keys>{"keys":["ESC",":q!","ENTER"]}</send_keys>
   - Other tools: <tool_name>{"arg":"value"}</tool_name>
   Use only listed tools. Never invent file-edit tools. Do not use legacy wrappers like >>> ... <<< or [TOOL: ...].
4. Use tools for terminal actions, system checks, files/paths, command results, latest web info, or page verification.
5. Judge requests by meaning, not keywords, across all user languages. Do not create a task list or plan unless the request genuinely needs one.
6. If terminal control is stuck in an interactive program, recover with CTRL_C on macOS. If OS is Windows, use PowerShell syntax only.
7. When the user asks for current events, recent facts, or web verification, prefer search_web instead of answering from memory when that tool is available.${buildTaskWorkflowPrompt(args.complexRequest)}
Current OS: ${args.currentOS}
Current Working Directory: ${args.currentWorkingDirectory}
Complex Request Mode: ${args.complexRequest ? 'enabled' : 'disabled'}

${renderAvailableToolsForPrompt(args.availableTools)}${globalUserPromptSection}`;
};

export const buildLLMMessages = ({
    history,
    baseSystemPrompt,
    includeScreenContext = false,
    deps,
}: BuildLLMMessagesArgs): PromptHarnessMessage[] => {
    const taskMemory = buildTaskMemory(history, deps);
    const compactHistory = buildCompactHistory(history, deps);
    const systemSections = [baseSystemPrompt, `TASK_MEMORY:\n${renderTaskMemory(taskMemory)}`];

    if (includeScreenContext) {
        systemSections.push(`SCREEN_CONTEXT:\n${deps.buildScreenContext(history)}`);
    }

    return [{
        role: 'system',
        content: systemSections.join('\n\n'),
    }, ...compactHistory];
};
