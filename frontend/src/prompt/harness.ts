export interface PromptHarnessMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    name?: string;
}

export interface PromptVisibleTool {
    name: string;
    description?: string;
    inputSchema?: {
        properties?: Record<string, { type?: string } | unknown>;
        required?: string[];
    };
}

export type AppToolRouteRecovery = {
    toolName: string;
    commandText: string;
    toolArgs: string;
    recovered: boolean;
    error?: string;
};

const unwrapInvocationValue = (value: string): string => {
    let normalized = value.trim();
    if (normalized.startsWith('(') && normalized.endsWith(')')) {
        normalized = normalized.slice(1, -1).trim();
    }
    if (
        normalized.length >= 2
        && ((normalized.startsWith('"') && normalized.endsWith('"'))
            || (normalized.startsWith("'") && normalized.endsWith("'")))
    ) {
        normalized = normalized.slice(1, -1);
    }
    return normalized.trim();
};

// Some local models put an app tool invocation inside execute_command, for
// example `search_web latest GPU news`. Detect that shape before anything is
// sent to the shell and recover it through the shared tool registry.
export const recoverAppToolRoutedAsCommand = (
    call: Pick<AppToolRouteRecovery, 'toolName' | 'commandText' | 'toolArgs'>,
    availableTools: PromptVisibleTool[],
): AppToolRouteRecovery => {
    const unchanged = { ...call, recovered: false };
    if (call.toolName !== 'execute_command') return unchanged;

    const normalizedCommand = call.commandText.trim();
    const normalizedLower = normalizedCommand.toLowerCase();
    const target = [...availableTools]
        .filter(tool => tool.name !== 'execute_command' && tool.name !== 'send_keys')
        .sort((left, right) => right.name.length - left.name.length)
        .find((tool) => {
            const toolName = tool.name.toLowerCase();
            if (!normalizedLower.startsWith(toolName)) return false;
            const boundary = normalizedCommand.charAt(tool.name.length);
            return !boundary || /[\s{(]/.test(boundary);
        });
    if (!target) return unchanged;

    let rawArguments = normalizedCommand.slice(target.name.length).trim();
    if (!rawArguments) {
        return {
            toolName: target.name,
            commandText: '',
            toolArgs: '{}',
            recovered: true,
            error: `${target.name} was routed as a terminal command but its arguments were missing.`,
        };
    }

    if (rawArguments.startsWith('(') && rawArguments.endsWith(')')) {
        rawArguments = rawArguments.slice(1, -1).trim();
    }

    if (rawArguments.startsWith('{')) {
        try {
            const parsed = JSON.parse(rawArguments);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return {
                    toolName: target.name,
                    commandText: rawArguments,
                    toolArgs: JSON.stringify(parsed),
                    recovered: true,
                };
            }
        } catch {
            return {
                toolName: target.name,
                commandText: rawArguments,
                toolArgs: '{}',
                recovered: true,
                error: `${target.name} was routed as a terminal command with invalid JSON arguments.`,
            };
        }
    }

    const properties = target.inputSchema?.properties || {};
    const propertyNames = Object.keys(properties);
    const required = Array.isArray(target.inputSchema?.required) ? target.inputSchema?.required || [] : [];
    const argumentName = required.length === 1
        ? required[0]
        : propertyNames.length === 1
            ? propertyNames[0]
            : '';

    if (!argumentName) {
        return {
            toolName: target.name,
            commandText: rawArguments,
            toolArgs: '{}',
            recovered: true,
            error: `${target.name} requires structured JSON arguments and cannot be interpreted as a terminal command.`,
        };
    }

    const value = unwrapInvocationValue(rawArguments);
    return {
        toolName: target.name,
        commandText: value,
        toolArgs: JSON.stringify({ [argumentName]: value }),
        recovered: true,
    };
};

export const shouldSuppressDuplicateAppToolCall = (toolName: string, previousExecutionCount: number): boolean => (
    previousExecutionCount > 0
    && toolName !== 'execute_command'
    && toolName !== 'send_keys'
);

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
    assistantName: string;
    currentOS: string;
    currentWorkingDirectory: string;
    currentRequest: string;
    complexRequest: boolean;
    availableTools: PromptVisibleTool[];
    globalUserPrompt: string;
};

const buildLocalTerminalRecipe = (request: string, currentOS: string): string => {
    const normalizedRequest = request.trim().toLowerCase();
    const normalizedOS = currentOS.trim().toLowerCase();
    if (!normalizedRequest || !normalizedOS.includes('mac')) return '';

    const recipes: string[] = [];
    if (/cpu|processor|코어|프로세서/.test(normalizedRequest)) {
        recipes.push('CPU model/physical/logical cores: sysctl -n machdep.cpu.brand_string; sysctl -n hw.physicalcpu; sysctl -n hw.logicalcpu');
    }
    if (/os\s*버전|운영체제|system\s*info|시스템\s*정보|macos\s*version/.test(normalizedRequest)) {
        recipes.push('OS/kernel: sw_vers; uname -a');
    }
    if (/부팅|부트|가동\s*시간|boot|uptime/.test(normalizedRequest)) {
        recipes.push('Boot/uptime: sysctl -n kern.boottime; uptime');
    }
    if (/디스크|disk|남은\s*용량|free\s*space/.test(normalizedRequest)) {
        recipes.push('Disk usage: df -h');
    }
    if (/큰.{0,12}파일|대용량.{0,12}파일|large(?:st)?.{0,24}files?/.test(normalizedRequest)) {
        recipes.push('Largest files under a directory: find TARGET -type f -exec du -k {} + 2>/dev/null | sort -nr | head -n COUNT');
    }
    if (/현재\s*(?:경로|디렉토리)|목록|directory|\bpwd\b|\blist\b/.test(normalizedRequest)) {
        recipes.push('Path/listing: pwd; ls -la. A read-only listing must not change the working directory.');
    }
    if (/디렉토리\s*이동|경로\s*이동|들어가|change\s+(?:the\s+)?directory|\bcd\s+to\b|\bgo\s+to\b|\bswitch\s+to\b/.test(normalizedRequest)) {
        recipes.push('Requested directory change: cd TARGET; pwd');
    }

    return recipes.length > 0
        ? `\nRelevant native macOS command hints (use only what the request needs):\n- ${recipes.join('\n- ')}`
        : '';
};

const SCREEN_CONTEXT_KEYWORDS = /화면|스크린|보이는|visible|ui|layout|버튼|입력창|chat|대화|terminal|터미널|prompt|프롬프트|nano|pico|vim|editor|편집기|pane|패널/i;
const TASK_MEMORY_REQUEST_LIMIT = 3;
const TASK_MEMORY_PLAN_LIMIT = 6;
const TASK_MEMORY_STEP_LIMIT = 6;
const TASK_MEMORY_EVIDENCE_LIMIT = 2;
const TASK_MEMORY_RECENT_MESSAGE_LIMIT = 6;
const TASK_MEMORY_CURRENT_REQUEST_LIMIT = 600;
const LATEST_REQUEST_CHAR_LIMIT = 4000;
const TOOL_RESULT_CHAR_LIMIT = 3600;

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

const clampPromptTextFromBothEnds = (value: string, maxLength: number): string => {
    const normalized = value.trim();
    if (normalized.length <= maxLength) return normalized;
    const tailLength = Math.max(1, Math.floor(maxLength / 4));
    const headLength = Math.max(1, maxLength - tailLength);
    return `${normalized.slice(0, headLength).trimEnd()}\n... (middle omitted) ...\n${normalized.slice(-tailLength).trimStart()}`;
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

const isSyntheticUserContent = (value: string, deps: PromptHarnessDeps): boolean => (
    deps.isSyntheticToolResponseContent(value) || /^\[App Notice\]/i.test(value.trim())
);

const getMeaningfulUserHistory = (history: PromptHarnessMessage[], deps: PromptHarnessDeps): PromptHarnessMessage[] => (
    history.filter(message => message.role === 'user' && message.content.trim() && !isSyntheticUserContent(message.content, deps))
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

    for (const message of [...history].reverse()) {
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
    const latestUser = meaningfulUsers[meaningfulUsers.length - 1];
    const recentRequests = meaningfulUsers
        .slice(-(TASK_MEMORY_REQUEST_LIMIT + 1), -1)
        .map(message => clampText(deps.stripMarkupForContext(message.content), 180));
    const request = latestUser
        ? clampPromptTextFromBothEnds(deps.stripMarkupForContext(latestUser.content), TASK_MEMORY_CURRENT_REQUEST_LIMIT)
        : '';

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
    const filtered = history
        .filter((message, index) => {
            if (index === 0 && message.role === 'assistant') return false;
            if (message.role === 'system' && /^Executing /.test(message.content.trim())) return false;
            if (message.role === 'assistant' && !deps.stripToolCallMarkup(deps.stripMarkupForContext(message.content)).trim()) return false;
            return Boolean(message.content.trim());
        });
    let latestMeaningfulUserIndex = -1;
    for (let index = filtered.length - 1; index >= 0; index -= 1) {
        const message = filtered[index];
        if (message.role === 'user' && !isSyntheticUserContent(message.content, deps)) {
            latestMeaningfulUserIndex = index;
            break;
        }
    }

    const recentStartIndex = Math.max(0, filtered.length - TASK_MEMORY_RECENT_MESSAGE_LIMIT);
    const recent = latestMeaningfulUserIndex >= 0 && latestMeaningfulUserIndex < recentStartIndex
        ? [filtered[latestMeaningfulUserIndex], ...filtered.slice(-(TASK_MEMORY_RECENT_MESSAGE_LIMIT - 1))]
        : filtered.slice(-TASK_MEMORY_RECENT_MESSAGE_LIMIT);

    return recent
        .map((message) => {
            const originalIndex = filtered.indexOf(message);
            const isToolResult = message.role === 'tool'
                || Boolean(message.name)
                || deps.isSyntheticToolResponseContent(message.content);
            if (originalIndex === latestMeaningfulUserIndex) {
                return {
                    ...message,
                    content: clampPromptTextFromBothEnds(message.content, LATEST_REQUEST_CHAR_LIMIT),
                };
            }
            if (isToolResult) {
                return {
                    ...message,
                    content: clampText(message.content, TOOL_RESULT_CHAR_LIMIT),
                };
            }
            const maxLength = message.role === 'assistant' ? 240 : 180;
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

const ACTIONABLE_REQUEST_PATTERN = /확인|조회|검색|열어|읽어|실행|생성|만들|삭제|이동|복사|설치|수정|고쳐|변경|설정|해결|진단|검사|경로|파일|폴더|버전|gpu|cpu|status|list|count|check|inspect|read|open|run|execute|create|delete|move|copy|install|fix|change|configure|resolve|diagnose|file|path|version/i;
const INSTRUCTION_ONLY_REQUEST_PATTERN = /방법|어떻게|가이드|예시|문서|(?:명령어?|command).{0,20}(?:알려|설명|추천|뭐|무엇|what|which)|(?:what|which).{0,20}(?:명령어?|command)|how\s+(?:do|can|to)|explain|guide|example/i;
const DELEGATED_ACTION_PATTERN = /(?:명령어?|명령|작업).{0,40}(?:실행|시도|확인).{0,15}(?:해\s*주세요|하세요|해보세요)|(?:직접|터미널에서).{0,30}(?:실행|시도|확인).{0,15}(?:해\s*주세요|하세요|해보세요)|please\s+(?:run|execute|try|check)\b|\b(?:run|execute|try)\s+(?:the\s+)?(?:following|this)\s+(?:command|check)\b/i;
const STRUCTURED_TOOL_CALL_PATTERN = /<(?!\/?(?:analysis|progress|tasklist|execution_plan|walkthrough|report|artifact)\b)([a-zA-Z0-9_:-]+)>\s*{[\s\S]*?}\s*<\/\1>/i;

export const shouldContinueAfterDelegatedAction = (response: string, userRequest: string): boolean => {
    const normalizedResponse = response.trim();
    const normalizedRequest = userRequest.trim();
    if (!normalizedResponse || !normalizedRequest) return false;
    if (!ACTIONABLE_REQUEST_PATTERN.test(normalizedRequest)) return false;
    if (INSTRUCTION_ONLY_REQUEST_PATTERN.test(normalizedRequest)) return false;
    if (STRUCTURED_TOOL_CALL_PATTERN.test(normalizedResponse)) return false;
    return DELEGATED_ACTION_PATTERN.test(normalizedResponse);
};

const LOCAL_SYSTEM_INSPECTION_PATTERN = /부팅|부트업|가동\s*시간|시스템\s*시간|현재\s*시간|cpu|gpu|메모리\s*(?:사용|용량|확인)|디스크\s*(?:사용|용량|확인)|프로세스|환경\s*변수|네트워크\s*(?:설정|상태)|ip\s*(?:주소|확인)|os\s*버전|운영체제\s*버전|uptime|boot\s*time|booted|memory\s*(?:usage|status)|disk\s*(?:usage|space)|running\s*process|environment\s*variable|network\s*(?:config|status)|ip\s*address/i;
const EXPLICIT_EXTERNAL_RESEARCH_PATTERN = /웹|인터넷|온라인|뉴스|검색해서|검색해줘|자료|사양|스펙|가격|비교|제품|모델|출시|벤치마크|web|internet|online|news|search\s+(?:the\s+)?web|specification|price|compare|product|release|benchmark/i;
const WEB_RESEARCH_TOOLS = new Set(['search_web', 'read_web_page', 'read_buffered_source', 'naver_search', 'namu_wiki']);

export const requiresLocalSystemEvidence = (userRequest: string): boolean => {
    const normalized = userRequest.trim();
    if (!normalized) return false;
    if (INSTRUCTION_ONLY_REQUEST_PATTERN.test(normalized)) return false;
    if (EXPLICIT_EXTERNAL_RESEARCH_PATTERN.test(normalized)) return false;
    return LOCAL_SYSTEM_INSPECTION_PATTERN.test(normalized);
};

export const shouldRedirectWebToolToLocalSystem = (userRequest: string, toolName: string): boolean => (
    WEB_RESEARCH_TOOLS.has(toolName.trim().toLowerCase()) && requiresLocalSystemEvidence(userRequest)
);

const RETRYABLE_TERMINAL_ASSESSMENTS = new Set([
    'command_failed',
    'error_output_detected',
    'interactive_launch_failed',
    'inconclusive',
]);

export const shouldRetryAfterTerminalAssessment = (
    assessment: string,
    recoveryPromptCount: number,
    maxRecoveryPrompts = 2,
): boolean => (
    RETRYABLE_TERMINAL_ASSESSMENTS.has(assessment.trim().toLowerCase())
    && recoveryPromptCount < maxRecoveryPrompts
);

const responseContainsLabeledValue = (response: string, labels: RegExp): boolean => {
    const normalized = response.replace(/[*_`#]/g, ' ');
    const flags = labels.flags.replace('g', '');
    const labelFirst = new RegExp(`${labels.source}.{0,48}(?:Apple\\s+)?[A-Za-z0-9][A-Za-z0-9 ._-]*`, flags);
    const valueFirst = new RegExp(`(?:\\d+|Apple\\s+[A-Za-z0-9 ._-]+).{0,24}${labels.source}`, flags);
    return labelFirst.test(normalized) || valueFirst.test(normalized);
};

const responseContainsLabeledNumber = (response: string, labels: RegExp): boolean => {
    const normalized = response.replace(/[*_`#]/g, ' ');
    const flags = labels.flags.replace('g', '');
    const labelFirst = new RegExp(`${labels.source}[^\\n]{0,32}\\b\\d+\\b`, flags);
    const valueFirst = new RegExp(`\\b\\d+\\b[^\\n]{0,20}${labels.source}`, flags);
    return labelFirst.test(normalized) || valueFirst.test(normalized);
};

export const getMissingRequestedLocalFacts = (response: string, userRequest: string): string[] => {
    const request = userRequest.trim();
    if (!request) return [];

    const missing: string[] = [];
    if (/(?:cpu|processor|프로세서).{0,20}(?:model|모델)|(?:model|모델).{0,20}(?:cpu|processor|프로세서)/i.test(request)
        && !responseContainsLabeledValue(response, /(?:cpu\s*)?(?:model|모델)/i)) {
        missing.push('CPU model');
    }
    if (/(?:physical|물리(?:적)?).{0,20}(?:core|코어)|(?:core|코어).{0,20}(?:physical|물리(?:적)?)/i.test(request)
        && !responseContainsLabeledNumber(response, /(?:physical\s*(?:core(?:s|\s*count)?)?|물리(?:적)?\s*코어(?:\s*수)?)/i)) {
        missing.push('physical core count');
    }
    if (/(?:logical|논리(?:적|컬)?).{0,20}(?:core|코어)|(?:core|코어).{0,20}(?:logical|논리(?:적|컬)?)/i.test(request)
        && !responseContainsLabeledNumber(response, /(?:logical\s*(?:core(?:s|\s*count)?)?|논리(?:적|컬)?\s*코어(?:\s*수)?)/i)) {
        missing.push('logical core count');
    }
    if (/숨김\s*(?:파일|항목)|hidden\s+(?:files?|entries)/i.test(request)
        && !/(?:^|[\s`(])\.[A-Za-z0-9_-]+|숨김[^\n]{0,24}(?:없|none|no\s+hidden)/im.test(response)) {
        missing.push('hidden entries');
    }

    return missing;
};

const DIRECTORY_CHANGE_REQUEST_PATTERN = /디렉토리\s*이동|경로\s*이동|폴더(?:로|에)\s*(?:이동|들어)|들어가|작업\s*경로.{0,12}(?:바꿔|변경)|change\s+(?:the\s+)?(?:working\s+)?directory|\bcd\s+(?:to\s+)?|\bgo\s+to\b|\bswitch\s+to\b/i;

export const shouldRejectUnexpectedDirectoryChange = (userRequest: string, command: string): boolean => (
    /(?:^|[;&|]\s*)cd(?:\s|$)/i.test(command)
    && !DIRECTORY_CHANGE_REQUEST_PATTERN.test(userRequest)
);

export const getMissingRequiredTerminalActions = (userRequest: string, commands: string[]): string[] => {
    const request = userRequest.trim();
    if (!request) return [];
    const executed = commands.join('\n');
    const missing: string[] = [];

    if (/(?:현재\s*)?(?:작업\s*)?(?:경로|디렉토리)|current\s+(?:working\s+)?directory|\bpwd\b/i.test(request)
        && !/(?:^|[;&|]\s*)pwd(?:\s|$)/im.test(executed)) {
        missing.push('current working directory check');
    }
    if (/목록|항목|숨김\s*파일|list(?:ing)?|entries|hidden\s+files?/i.test(request)
        && !/(?:^|[;&|]\s*)(?:ls|find)(?:\s|$)/im.test(executed)) {
        missing.push('directory listing');
    }
    if (/디스크|남은\s*용량|disk\s*(?:usage|space)|free\s*space/i.test(request)
        && !/(?:^|[;&|]\s*)df(?:\s|$)/im.test(executed)) {
        missing.push('disk usage check');
    }
    if (/큰.{0,12}파일|대용량.{0,12}파일|large(?:st)?.{0,24}files?/i.test(request)
        && (!/\bfind\b/im.test(executed) || !/\b(?:du|stat)\b/im.test(executed))) {
        missing.push('large-file scan');
    }
    if (DIRECTORY_CHANGE_REQUEST_PATTERN.test(request)
        && !/(?:^|[;&|]\s*)cd(?:\s|$)/im.test(executed)) {
        missing.push('requested directory change');
    }

    return missing;
};

export type RecoveredTrailingToolCall = {
    raw: string;
    toolName: string;
    payloadText: string;
};

export const recoverTrailingJsonToolCall = (response: string): RecoveredTrailingToolCall | null => {
    const match = response.match(/<([a-zA-Z0-9_:-]+)>\s*(\{[\s\S]*\})\s*>?\s*$/i);
    if (!match) return null;
    return {
        raw: match[0],
        toolName: match[1].toLowerCase(),
        payloadText: match[2],
    };
};

const buildTaskWorkflowPrompt = (complexRequest: boolean): string => {
    if (!complexRequest) return '';

    return `
13. COMPLEX TASK MODE: The app already suspects this request may be complex, but you must still decide this yourself from the user's meaning, not from keywords or UI language. Before responding, quickly classify the request as either:
   - QUICK RESPONSE: a simple answer, brief explanation, or single obvious action that does not need planning
   - PLANNED TASK: work that needs multiple steps, implementation, investigation, refactoring, review, or coordination
   Only use task-oriented structure when it is truly a PLANNED TASK.
14. COMPLEX TASK FORMAT: For a PLANNED TASK, the first substantial assistant response may include these blocks in order when they add value:
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
15. COMPLEX TASK BEHAVIOR: If it is a QUICK RESPONSE, answer directly and do not create a task list, execution plan, or runbook framing. If it is a PLANNED TASK, do not only propose a plan. Actually carry out the work, keep the task list aligned with the work performed, and finish with a completion report.`;
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
        const exampleArgs = propertyNames.reduce<Record<string, unknown>>((result, name) => {
            const property = schema?.properties?.[name];
            const propertyType = property && typeof property === 'object' && 'type' in property
                ? property.type
                : 'string';
            result[name] = propertyType === 'integer' || propertyType === 'number'
                ? 0
                : propertyType === 'boolean'
                    ? false
                    : propertyType === 'array'
                        ? []
                        : '...';
            return result;
        }, {});
        const argsText = propertyNames.length
            ? ` args: ${propertyNames.map((name) => `${name}${required.includes(name) ? '*' : ''}`).join(', ')}`
            : ' args: none';
        const callExample = `<${tool.name}>${JSON.stringify(exampleArgs)}</${tool.name}>`;
        return `- ${tool.name}: ${(tool.description || '').trim()}${argsText}; call: ${callExample}`;
    });

    lines.push('- App tool names are not shell commands. Never place search_web, read_web_page, or another listed app tool inside execute_command. Call its own tag exactly as shown above.');
    lines.push('- Use execute_command or another local tool for facts about this computer (boot time, uptime, CPU/GPU, memory, disk, processes, OS, files, or network state). Do not use web search for local machine state.');
    lines.push('- Prefer search_web only for current/latest external internet information when it is available.');
    lines.push('- Use read_web_page only for a specific URL or when the user explicitly asks to inspect a page.');
    lines.push('- When a web tool returns a buffered source and says focused excerpts are required, call read_buffered_source before giving a detailed answer.');

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

PERSISTENT USER PREFERENCE:
Treat this as persistent user preference/context unless it conflicts with safety, exact tool syntax, or the current request.
[BEGIN_GLOBAL_USER_PROMPT]
${trimmedGlobalUserPrompt}
[END_GLOBAL_USER_PROMPT]`
        : '';

    const localTerminalRecipe = buildLocalTerminalRecipe(args.currentRequest, args.currentOS);
    const quickRequestRule = args.complexRequest
        ? ''
        : '\nQuick Request Enforcement: Do not emit <analysis>, <progress>, <tasklist>, <execution_plan>, <artifact>, or a plan. For related read-only facts, combine native commands into one execute_command when safe, observe once, and answer concisely.';

    return `You are ${args.assistantName}, a professional AI engineer.
1. Keep answers compact for a narrow side chat. First decide whether the user's request needs a quick direct response or a planned multi-step task. Use <analysis>, <progress>, and <artifact> only when helpful.
2. SCREEN_CONTEXT is only for visible UI/terminal/chat state. Do not use it as proof for files, paths, counts, command output, or other verifiable system facts when tools can check them.
3. Tool syntax is strict. Use exactly one structured format for all tool calls:
   - Terminal command: <execute_command>{"command":"YOUR_COMMAND"}</execute_command>
   - Terminal keys: <send_keys>{"keys":["ESC",":q!","ENTER"]}</send_keys>
   - Other tools: <tool_name>{"arg":"value"}</tool_name>
   Use only listed tools. Never invent file-edit tools. Do not use legacy wrappers like >>> ... <<< or [TOOL: ...].
4. Use tools for terminal actions, system checks, files/paths, command results, latest web info, or page verification. Route facts about the user's current computer to execute_command or another local tool, never to web search. For example, inspect boot time with the native OS command (macOS: sysctl -n kern.boottime; Linux: uptime -s; Windows: PowerShell Get-CimInstance).
5. OWN THE TASK: Within the user's requested scope, keep working until the requested outcome is completed or a real blocker remains. If you know a safe next action and an available tool can perform it, perform it yourself. Do not tell the user to run a command, inspect a file, retry a known fix, or verify a result that you can do with the available tools.
6. RECOVER AND ADAPT: When an attempt fails, read the actual error, account for Current OS and Current Working Directory, and try a safe alternative or diagnostic. For example, replace an unavailable Linux command with the native macOS or PowerShell equivalent. Verify the result before reporting success; do not stop at the first failed attempt when another reasonable in-scope approach exists.
7. REQUEST USER INPUT ONLY WHEN NECESSARY: Ask only when essential information cannot be discovered with tools, an explicit safety/approval boundary is reached, credentials or external access are required, or the user must make a consequential choice. Explain the concrete blocker when asking.
8. Judge requests by meaning, not keywords, across all user languages. Do not create a task list or plan unless the request genuinely needs one.
9. If terminal control is stuck in an interactive program, recover with CTRL_C on macOS. If OS is Windows, use PowerShell syntax only.
10. When the user asks for current events, recent external facts, or web verification, prefer search_web instead of answering from memory when that tool is available.
11. PRIVATE COMPLETION LOOP: Before choosing an action and after every tool result, reason internally through: the user's actual goal; the evidence required; the evidence observed; a verdict of SATISFIED, FAILED, or INCONCLUSIVE; and the safest next action. Use this reasoning to guide work, but do not reveal private chain-of-thought. Give only concise conclusions, actions, and evidence to the user.
12. FINALIZATION GATE: Finish only when the goal is SATISFIED with observed evidence, or when a concrete BLOCKED condition prevents further progress. For a request containing multiple facts or actions, verify and answer every requested item before finishing. A failed, inconclusive, partial, or visibly truncated answer is not completion. If another safe in-scope action can resolve or verify it, perform that action and reassess before answering.
13. NEVER FABRICATE OUTPUT: Do not draft example, predicted, hardcoded, or placeholder terminal results before a tool runs. Artifacts and reports may contain only values actually observed from completed tool results.${buildTaskWorkflowPrompt(args.complexRequest)}
Current OS: ${args.currentOS}
Current Working Directory: ${args.currentWorkingDirectory}
Complex Request Mode: ${args.complexRequest ? 'enabled' : 'disabled'}${quickRequestRule}${localTerminalRecipe}

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
