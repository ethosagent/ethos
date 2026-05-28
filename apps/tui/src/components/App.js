import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { DEFAULT_TOKENS } from '@ethosagent/design-tokens';
import { createMemoryProvider } from '@ethosagent/wiring';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BUILTIN_SKIN_NAMES, BUILTIN_SKINS, personalityAccent, resolveSkin, SkinContext, } from '../skin';
import { getUpdateStatus } from '../update-check';
import { AccordionSection } from './AccordionSection';
import { ChatRow, StreamingRow } from './ChatPane';
import { ClarifyModal } from './ClarifyModal';
import { CompletionPanel, getMatches } from './CompletionPanel';
import { ConsoleHeader } from './ConsoleHeader';
import { ContextPanel } from './ContextPanel';
import { ExecutionTimeline } from './ExecutionTimeline';
import { FileActivityPanel } from './FileActivityPanel';
import { IdentityPanel } from './IdentityPanel';
import { InputBox } from './InputBox';
import { KeymapOverlay } from './KeymapOverlay';
import { ModelPickerModal } from './ModelPickerModal';
import { SafetyLane } from './SafetyLane';
import { SessionPickerModal } from './SessionPickerModal';
import { Splash } from './Splash';
import { StatusBar } from './StatusBar';
import { SubagentsPane } from './SubagentsPane';
import { ThinkingPane } from './ThinkingPane';
import { ToolSpinner } from './ToolSpinner';
function fmtSecs(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
}
function fmtTokens(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
function formatVerboseSummary(t) {
    const total = t.turnEnd - t.turnStart;
    const toolsTotal = t.toolDurations.reduce((a, b) => a + b, 0);
    const llm = Math.max(0, total - toolsTotal);
    const ttft = t.firstTextDeltaAt !== null ? t.firstTextDeltaAt - t.turnStart : null;
    const parts = [];
    parts.push(`llm ${fmtSecs(llm)}${ttft !== null ? ` (TTFT ${fmtSecs(ttft)})` : ''}`);
    if (t.toolDurations.length > 0) {
        const n = t.toolDurations.length;
        parts.push(`tools ${fmtSecs(toolsTotal)} (${n} call${n === 1 ? '' : 's'})`);
    }
    parts.push(`total ${fmtSecs(total)}`);
    if (t.turnUsage) {
        parts.push(`${fmtTokens(t.turnUsage.inputTokens)} in`);
        parts.push(`${fmtTokens(t.turnUsage.outputTokens)} out`);
        if (t.turnUsage.estimatedCostUsd > 0) {
            parts.push(`$${t.turnUsage.estimatedCostUsd.toFixed(3)}`);
        }
    }
    return `↳ ${parts.join(' · ')}`;
}
function extractDiff(result) {
    if (!result)
        return undefined;
    const lines = result.split('\n');
    const diffStart = lines.findIndex((l) => l.startsWith('@@') || l.startsWith('---') || l.startsWith('+++'));
    if (diffStart === -1)
        return undefined;
    return lines.slice(diffStart).join('\n');
}
/**
 * Skin resolution: a valid user pin (`--skin` flag, config.yaml, or
 * `/skin <name>`) wins; otherwise the engine default. Per-personality skin
 * overrides were removed in the personality-alignment phase — a personality
 * is an identity, not a theme.
 */
function pickEffectiveSkin(userPin) {
    if (userPin && BUILTIN_SKINS[userPin])
        return userPin;
    return 'default';
}
function resolveTokensFor(skinName) {
    try {
        return resolveSkin(DEFAULT_TOKENS, BUILTIN_SKINS, skinName);
    }
    catch {
        return DEFAULT_TOKENS;
    }
}
const DEFAULT_DETAILS = {
    global: 'collapsed',
    thinking: 'expanded',
    tools: 'expanded',
    subagents: null,
    activity: 'hidden',
};
function resolveMode(section, global) {
    return section ?? global;
}
export function App({ bridge, model, initialPersonality, initialSessionKey, initialVerbose = false, initialSkin, rebuildLoop, inventory, version, }) {
    const { exit } = useApp();
    const [messages, setMessages] = useState([]);
    const [streamingText, setStreamingText] = useState('');
    const [thinkingText, setThinkingText] = useState('');
    const [input, setInput] = useState('');
    const [activeTools, setActiveTools] = useState([]);
    const [completedTools, setCompletedTools] = useState([]);
    const [delegations, setDelegations] = useState([]);
    const [running, setRunning] = useState(false);
    const [interrupted, setInterrupted] = useState(false);
    const [personality, setPersonality] = useState(initialPersonality);
    const [currentModel, setCurrentModel] = useState(model);
    const [sessionKey, setSessionKey] = useState(initialSessionKey);
    const [usage, setUsage] = useState({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
    const [statusMsg, setStatusMsg] = useState('');
    const [details, setDetails] = useState(DEFAULT_DETAILS);
    // Skin state — a valid user pin wins, otherwise the engine default.
    // `userPinnedSkin` is the value the user set via `--skin` flag, config.yaml,
    // or `/skin <name>`. Per-personality skin overrides were removed in the
    // personality-alignment phase.
    const [userPinnedSkin, setUserPinnedSkin] = useState(() => initialSkin && BUILTIN_SKINS[initialSkin] ? initialSkin : null);
    const [tokens, setTokens] = useState(() => {
        const effective = pickEffectiveSkin(initialSkin && BUILTIN_SKINS[initialSkin] ? initialSkin : null);
        return resolveTokensFor(effective);
    });
    const applyTokensFor = useCallback((userPin) => {
        const effective = pickEffectiveSkin(userPin);
        setTokens(resolveTokensFor(effective));
        return effective;
    }, []);
    const [modal, setModal] = useState(null);
    const [clarifyRequest, setClarifyRequest] = useState(null);
    const [completionIndex, setCompletionIndex] = useState(0);
    const [timelineEvents, setTimelineEvents] = useState([]);
    const [history, setHistory] = useState([]);
    const [historyIndex, setHistoryIndex] = useState(null);
    const [historyDraft, setHistoryDraft] = useState('');
    const [columns, setColumns] = useState(process.stdout.columns ?? 120);
    const [focusPane, setFocusPane] = useState('input');
    const [showKeymap, setShowKeymap] = useState(false);
    const [fileActivity, setFileActivity] = useState([]);
    const [selectedPatchIndex, setSelectedPatchIndex] = useState(0);
    const [readonlyMode, setReadonlyMode] = useState(false);
    const [updateStatus, setUpdateStatus] = useState(null);
    const [budgetCapUsd, setBudgetCapUsd] = useState(() => bridge.getPersonalityBudgetCap(initialPersonality) ?? null);
    const verboseRef = useRef(initialVerbose);
    const [verboseDisplay, setVerboseDisplay] = useState(initialVerbose);
    const turnStartRef = useRef(null);
    const firstTextDeltaAtRef = useRef(null);
    const turnToolDurationsRef = useRef([]);
    const turnUsageRef = useRef(null);
    const [turnElapsed, setTurnElapsed] = useState(0);
    const fileByToolCallRef = useRef(new Map());
    const activityByToolCallRef = useRef(new Map());
    const delegationByToolCallRef = useRef(new Map());
    const idRef = useRef(0);
    const nextId = () => String(++idRef.current);
    const [hudSnapshots, setHudSnapshots] = useState(() => [
        {
            id: 'hud-initial',
            personality: initialPersonality,
            model,
            sessionKey: initialSessionKey,
            accentColor: personalityAccent(initialPersonality),
        },
    ]);
    const completionMatches = useMemo(() => getMatches(input), [input]);
    const completionVisible = completionMatches.length > 0 && input.startsWith('/');
    const agentStatus = useMemo(() => {
        if (interrupted)
            return 'interrupted';
        if (activeTools.length > 0)
            return 'running';
        if (running)
            return 'thinking';
        return 'idle';
    }, [interrupted, activeTools.length, running]);
    const currentTool = activeTools.length > 0 ? activeTools[activeTools.length - 1]?.toolName : undefined;
    const accentColor = useMemo(() => personalityAccent(personality), [personality]);
    const showIdentityPane = columns >= 90;
    const showSplash = messages.length === 0 && !running && !streamingText;
    // Focus order: side panels live in <Static> scrollback (the HUD snapshot)
    // and aren't part of the live Ink frame anymore, so only the input pane
    // is focusable. The 'files' pane stays in the list because patch approval
    // (a/d hotkeys) still operates on pendingPatchEntries from state — the
    // FileActivityPanel snapshot just shows the moment it was taken.
    const focusOrder = useMemo(() => ['files', 'input'], []);
    const pushTimeline = (level, text) => {
        const at = new Date().toISOString().slice(11, 19);
        setTimelineEvents((prev) => [...prev, { id: nextId(), at, level, text }]);
    };
    const extractPath = (args) => {
        if (!args || typeof args !== 'object')
            return null;
        const obj = args;
        const raw = obj.filePath ?? obj.path ?? obj.filename;
        if (typeof raw !== 'string' || raw.trim().length === 0)
            return null;
        return raw;
    };
    const inferFileAction = (toolName) => {
        if (toolName === 'read_file')
            return 'read';
        if (toolName === 'write_file')
            return 'write';
        if (toolName.includes('patch'))
            return 'patch';
        return null;
    };
    const pendingPatchEntries = useMemo(() => fileActivity.filter((e) => e.status === 'approval_required'), [fileActivity]);
    const selectedPatchEntry = pendingPatchEntries[selectedPatchIndex] ?? null;
    const appendFileActivity = (action, path, status) => {
        const id = nextId();
        const at = new Date().toISOString().slice(11, 19);
        setFileActivity((prev) => [...prev, { id, at, action, path, status }]);
        return id;
    };
    const updateFileActivityStatus = (id, status, diff) => {
        const at = new Date().toISOString().slice(11, 19);
        setFileActivity((prev) => prev.map((entry) => entry.id === id ? { ...entry, status, at, ...(diff !== undefined ? { diff } : {}) } : entry));
    };
    const delegationLabel = (toolName, args) => {
        const a = args && typeof args === 'object' ? args : {};
        if (toolName === 'delegate_task') {
            const p = typeof a.personality === 'string' ? ` -> ${a.personality}` : '';
            const label = typeof a.label === 'string' ? ` (${a.label})` : '';
            return `delegate_task${p}${label}`;
        }
        if (toolName === 'route_to_agent') {
            const capability = typeof a.capability === 'string' ? ` cap=${a.capability}` : '';
            return `route_to_agent${capability}`;
        }
        if (toolName === 'dispatch_team') {
            const tasks = Array.isArray(a.tasks) ? a.tasks.length : 0;
            return `dispatch_team tasks=${tasks}`;
        }
        if (toolName === 'mixture_of_agents') {
            const agents = Array.isArray(a.agents) ? a.agents.length : 0;
            return `mixture_of_agents agents=${agents}`;
        }
        if (toolName === 'broadcast_to_agents') {
            const capability = typeof a.capability === 'string' ? ` cap=${a.capability}` : '';
            return `broadcast_to_agents${capability}`;
        }
        return toolName;
    };
    const pushDelegation = (id, capability) => {
        setDelegations((prev) => [...prev, { id, capability, status: 'pending' }]);
    };
    const updateDelegation = (id, patch) => {
        setDelegations((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    };
    const cycleFocus = (dir) => {
        const idx = focusOrder.indexOf(focusPane);
        const current = idx === -1 ? focusOrder.length - 1 : idx;
        const next = (current + dir + focusOrder.length) % focusOrder.length;
        const pane = focusOrder[next] ?? 'input';
        setFocusPane(pane);
        setStatusMsg(`[focus: ${pane}]`);
    };
    useEffect(() => {
        if (version) {
            getUpdateStatus(version)
                .then(setUpdateStatus)
                .catch(() => null);
        }
    }, [version]);
    // Append a fresh HUD snapshot whenever the personality, model, or session
    // changes — these are the rare events that warrant re-showing the chrome.
    // Within a single conversation the snapshot stays put in scrollback above
    // the message log; the bottom StatusBar carries live turn state.
    // biome-ignore lint/correctness/useExhaustiveDependencies: nextId closes over a stable ref; intentionally react only to identity changes
    useEffect(() => {
        setHudSnapshots((prev) => {
            const last = prev[prev.length - 1];
            if (!last)
                return prev;
            if (last.personality === personality &&
                last.model === currentModel &&
                last.sessionKey === sessionKey) {
                return prev;
            }
            return [
                ...prev,
                {
                    id: `hud-${nextId()}`,
                    personality,
                    model: currentModel,
                    sessionKey,
                    accentColor,
                },
            ];
        });
    }, [personality, currentModel, sessionKey, accentColor]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on match count change
    useEffect(() => {
        setCompletionIndex(0);
    }, [completionMatches.length]);
    useInput((ch, key) => {
        if (showKeymap) {
            if (key.escape || ch === '?')
                setShowKeymap(false);
            return;
        }
        if (key.ctrl && ch === 'c') {
            if (running) {
                bridge.abortTurn();
                setInterrupted(true);
                pushTimeline('warning', 'turn aborted by user');
            }
            else {
                exit();
            }
            return;
        }
        if (key.tab) {
            if (focusPane === 'input' && completionVisible && !key.shift)
                return;
            cycleFocus(key.shift ? -1 : 1);
            return;
        }
        if (focusPane === 'files') {
            if (key.upArrow) {
                setSelectedPatchIndex((i) => Math.max(0, i - 1));
                return;
            }
            if (key.downArrow) {
                setSelectedPatchIndex((i) => Math.min(pendingPatchEntries.length - 1, i + 1));
                return;
            }
            if (ch === 'a' && selectedPatchEntry) {
                updateFileActivityStatus(selectedPatchEntry.id, 'approved');
                pushTimeline('success', `patch approved: ${selectedPatchEntry.path}`);
                setStatusMsg(`[approved] ${selectedPatchEntry.path}`);
                return;
            }
            if (ch === 'd' && selectedPatchEntry) {
                updateFileActivityStatus(selectedPatchEntry.id, 'denied');
                pushTimeline('error', `patch denied: ${selectedPatchEntry.path}`);
                setStatusMsg(`[denied] ${selectedPatchEntry.path}`);
                return;
            }
        }
        if (ch === '?' && (focusPane !== 'input' || input.length === 0)) {
            setShowKeymap(true);
        }
    }, { isActive: modal === null && clarifyRequest === null });
    useEffect(() => {
        if (!focusOrder.includes(focusPane))
            setFocusPane('input');
    }, [focusPane, focusOrder]);
    useEffect(() => {
        if (pendingPatchEntries.length === 0) {
            setSelectedPatchIndex(0);
            return;
        }
        if (selectedPatchIndex >= pendingPatchEntries.length) {
            setSelectedPatchIndex(pendingPatchEntries.length - 1);
        }
    }, [pendingPatchEntries.length, selectedPatchIndex]);
    useEffect(() => {
        const onResize = () => setColumns(process.stdout.columns ?? 120);
        process.stdout.on('resize', onResize);
        return () => {
            process.stdout.off('resize', onResize);
        };
    }, []);
    useEffect(() => {
        if (!running) {
            setTurnElapsed(0);
            return;
        }
        const interval = setInterval(() => {
            if (turnStartRef.current !== null) {
                setTurnElapsed(Math.floor((Date.now() - turnStartRef.current) / 1000));
            }
        }, 1000);
        return () => clearInterval(interval);
    }, [running]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: nextId closes over a stable ref
    useEffect(() => {
        const onTextDelta = (text) => {
            if (firstTextDeltaAtRef.current === null)
                firstTextDeltaAtRef.current = Date.now();
            setStreamingText((prev) => prev + text);
        };
        const onThinkingDelta = (thinking) => setThinkingText((prev) => prev + thinking);
        const onDone = (text) => {
            const newMessages = [];
            if (text.trim())
                newMessages.push({ id: nextId(), role: 'assistant', text });
            if (verboseRef.current && turnStartRef.current !== null) {
                const summary = formatVerboseSummary({
                    turnStart: turnStartRef.current,
                    turnEnd: Date.now(),
                    firstTextDeltaAt: firstTextDeltaAtRef.current,
                    toolDurations: turnToolDurationsRef.current,
                    turnUsage: turnUsageRef.current,
                });
                newMessages.push({ id: nextId(), role: 'assistant', text: summary });
            }
            if (newMessages.length > 0)
                setMessages((prev) => [...prev, ...newMessages]);
            setStreamingText('');
            setThinkingText('');
            setRunning(false);
            pushTimeline('success', 'turn complete');
        };
        const onToolStart = (toolCallId, toolName, args) => {
            setActiveTools((prev) => [...prev, { toolCallId, toolName }]);
            pushTimeline('info', `tool start: ${toolName}`);
            const isDelegationTool = toolName === 'delegate_task' ||
                toolName === 'mixture_of_agents' ||
                toolName === 'route_to_agent' ||
                toolName === 'dispatch_team' ||
                toolName === 'broadcast_to_agents';
            if (isDelegationTool) {
                const delegationId = nextId();
                delegationByToolCallRef.current.set(toolCallId, delegationId);
                pushDelegation(delegationId, delegationLabel(toolName, args));
            }
            const action = inferFileAction(toolName);
            const path = extractPath(args);
            if (action && path) {
                fileByToolCallRef.current.set(toolCallId, { action, path });
                const activityId = appendFileActivity(action, path, 'active');
                activityByToolCallRef.current.set(toolCallId, activityId);
            }
        };
        const onToolProgress = (toolName, message, percent) => {
            setActiveTools((prev) => prev.map((t) => (t.toolName === toolName ? { ...t, message, percent } : t)));
            if (message) {
                const suffix = percent !== undefined ? ` (${percent}%)` : '';
                pushTimeline('info', `${toolName}: ${message}${suffix}`);
            }
        };
        const onToolEnd = (toolCallId, toolName, ok, durationMs, result) => {
            setActiveTools((prev) => prev.filter((t) => t.toolCallId !== toolCallId));
            setCompletedTools((prev) => [...prev, { id: toolCallId, toolName, ok, durationMs }]);
            turnToolDurationsRef.current.push(durationMs);
            const preview = result ? ` -> ${result.replace(/\s+/g, ' ').slice(0, 56)}` : '';
            pushTimeline(ok ? 'success' : 'error', `tool end: ${toolName} (${durationMs}ms)${preview}`);
            const fileMeta = fileByToolCallRef.current.get(toolCallId);
            const activityId = activityByToolCallRef.current.get(toolCallId);
            if (fileMeta && activityId) {
                const diff = extractDiff(result);
                const finalStatus = ok && fileMeta.action !== 'read' ? 'approval_required' : ok ? 'done' : 'error';
                updateFileActivityStatus(activityId, finalStatus, diff);
                fileByToolCallRef.current.delete(toolCallId);
                activityByToolCallRef.current.delete(toolCallId);
            }
            const delegationId = delegationByToolCallRef.current.get(toolCallId);
            if (delegationId) {
                updateDelegation(delegationId, {
                    status: ok ? 'done' : 'failed',
                    durationMs,
                    ...(ok ? {} : { error: result?.slice(0, 200) }),
                });
                delegationByToolCallRef.current.delete(toolCallId);
            }
        };
        const onUsage = (inputTokens, outputTokens, estimatedCostUsd) => {
            setUsage((prev) => ({
                inputTokens: prev.inputTokens + inputTokens,
                outputTokens: prev.outputTokens + outputTokens,
                costUsd: prev.costUsd + estimatedCostUsd,
            }));
            turnUsageRef.current = { inputTokens, outputTokens, estimatedCostUsd };
        };
        const onError = (error, code) => {
            setMessages((prev) => [
                ...prev,
                { id: nextId(), role: 'assistant', text: `[${code}] ${error}` },
            ]);
            setStreamingText('');
            setThinkingText('');
            setRunning(false);
            pushTimeline('error', `[${code}] ${error}`);
        };
        const onQueued = (_input, queueDepth) => {
            pushTimeline('warning', `input queued (depth=${queueDepth})`);
        };
        const onIdle = () => {
            if (bridge.queueDepth > 0) {
                pushTimeline('info', `draining queue (remaining=${bridge.queueDepth})`);
            }
        };
        // Phase 5: update status bar when effective model differs from the
        // initial config (e.g. per-personality routing, team overrides).
        const onRunStart = (_provider, resolvedModel) => {
            setCurrentModel(resolvedModel);
        };
        bridge.on('text_delta', onTextDelta);
        bridge.on('thinking_delta', onThinkingDelta);
        bridge.on('done', onDone);
        bridge.on('tool_start', onToolStart);
        bridge.on('tool_progress', onToolProgress);
        bridge.on('tool_end', onToolEnd);
        bridge.on('usage', onUsage);
        bridge.on('error', onError);
        bridge.on('queued', onQueued);
        bridge.on('idle', onIdle);
        bridge.on('run_start', onRunStart);
        return () => {
            bridge.off('text_delta', onTextDelta);
            bridge.off('thinking_delta', onThinkingDelta);
            bridge.off('done', onDone);
            bridge.off('tool_start', onToolStart);
            bridge.off('tool_progress', onToolProgress);
            bridge.off('tool_end', onToolEnd);
            bridge.off('usage', onUsage);
            bridge.off('error', onError);
            bridge.off('queued', onQueued);
            bridge.off('idle', onIdle);
            bridge.off('run_start', onRunStart);
        };
    }, [bridge]);
    // Clarify surface — open the modal when the agent calls the `clarify` tool,
    // and close it when the request resolves (answer / timeout / cancel).
    // Registered through the bridge so it survives `replaceLoop` (model switch).
    useEffect(() => {
        bridge.setClarifyPresenter((req) => setClarifyRequest(req));
        return bridge.onClarifyResolved(() => setClarifyRequest(null));
    }, [bridge]);
    const applyCompletion = () => {
        if (!completionVisible)
            return;
        const match = completionMatches[completionIndex];
        if (!match)
            return;
        setInput(`/${match.name} `);
    };
    const handleSubmit = async (value) => {
        if (!value.trim())
            return;
        setStatusMsg('');
        setInterrupted(false);
        setHistoryIndex(null);
        setHistoryDraft('');
        setHistory((prev) => {
            if (value.trim().length === 0)
                return prev;
            if (prev.at(-1) === value)
                return prev;
            return [...prev, value];
        });
        if (value.startsWith('/')) {
            setInput('');
            await handleSlashCommand(value);
            return;
        }
        if (running)
            return;
        if (readonlyMode) {
            setStatusMsg('[readonly mode] execution blocked; use /readonly to disable');
            pushTimeline('warning', 'blocked prompt while readonly mode enabled');
            return;
        }
        setInput('');
        setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: value }]);
        pushTimeline('info', `user: ${value.slice(0, 80)}`);
        setCompletedTools([]);
        setRunning(true);
        turnStartRef.current = Date.now();
        firstTextDeltaAtRef.current = null;
        turnToolDurationsRef.current = [];
        turnUsageRef.current = null;
        bridge.send(value, { sessionKey, personalityId: personality });
    };
    const handleSlashCommand = async (cmd) => {
        const parts = cmd.slice(1).trim().split(/\s+/);
        const name = parts[0]?.toLowerCase() ?? '';
        const args = parts.slice(1);
        switch (name) {
            case 'help':
                setMessages((prev) => [
                    ...prev,
                    {
                        id: nextId(),
                        role: 'assistant',
                        text: '/new                          fresh session\n' +
                            '/personality [list|<id>]      switch personality\n' +
                            '/model                        open model picker\n' +
                            '/sessions                     open session picker\n' +
                            '/memory                       show ~/.ethos/MEMORY.md\n' +
                            '/usage                        token + cost stats\n' +
                            '/budget                       show session spend vs cap\n' +
                            '/budget reset                 reset budget counter\n' +
                            `/readonly                     toggle readonly mode (now: ${readonlyMode ? 'on' : 'off'})\n` +
                            `/verbose                      toggle timing (now: ${verboseDisplay ? 'on' : 'off'})\n` +
                            '/details [hidden|collapsed|expanded] [section]\n' +
                            '/skin [list|<name>]           switch UI theme\n' +
                            '/tools                        list all available tools\n' +
                            '/skills                       list available skills\n' +
                            '/exit                         quit',
                    },
                ]);
                break;
            case 'new':
            case 'reset': {
                const oldKey = sessionKey;
                const newKey = `cli:${basename(process.cwd())}:${Date.now()}`;
                bridge.resetSessionCost(oldKey);
                setSessionKey(newKey);
                setMessages([]);
                setCompletedTools([]);
                setDelegations([]);
                setTimelineEvents([]);
                setFileActivity([]);
                setUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
                setStatusMsg('[new session started]');
                break;
            }
            case 'personality':
                if (args.length === 0) {
                    setStatusMsg(`personality: ${personality}`);
                }
                else if (args[0] === 'list') {
                    setMessages((prev) => [
                        ...prev,
                        {
                            id: nextId(),
                            role: 'assistant',
                            text: 'Built-ins: researcher · engineer · reviewer · coach · operator\nUser: ~/.ethos/personalities/<id>/',
                        },
                    ]);
                }
                else {
                    const newPersonality = args[0] ?? personality;
                    setPersonality(newPersonality);
                    setBudgetCapUsd(bridge.getPersonalityBudgetCap(newPersonality) ?? null);
                    setStatusMsg(`[personality: ${newPersonality}]`);
                }
                break;
            case 'model':
                setModal('models');
                break;
            case 'sessions':
                setModal('sessions');
                break;
            case 'memory': {
                try {
                    const mem = createMemoryProvider({ dataDir: `${homedir()}/.ethos` });
                    const result = await mem.prefetch({
                        scopeId: `personality:${personality}`,
                        sessionId: '',
                        sessionKey,
                        platform: 'cli',
                        workingDir: process.cwd(),
                    });
                    if (result && result.entries.length > 0) {
                        setMessages((prev) => [
                            ...prev,
                            {
                                id: nextId(),
                                role: 'assistant',
                                text: result.entries.map((e) => e.content.trim()).join('\n\n'),
                            },
                        ]);
                    }
                    else {
                        setStatusMsg('[no memory yet — chat to build it]');
                    }
                }
                catch (err) {
                    setStatusMsg(`[memory error: ${err instanceof Error ? err.message : String(err)}]`);
                }
                break;
            }
            case 'usage':
                setMessages((prev) => [
                    ...prev,
                    {
                        id: nextId(),
                        role: 'assistant',
                        text: `Tokens: ${usage.inputTokens.toLocaleString()} in · ${usage.outputTokens.toLocaleString()} out\n` +
                            `Cost: $${usage.costUsd.toFixed(5)}`,
                    },
                ]);
                break;
            case 'budget': {
                if (args[0] === 'reset') {
                    bridge.resetSessionCost(sessionKey);
                    setUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
                    setStatusMsg('[budget counter reset]');
                    break;
                }
                const cap = budgetCapUsd;
                setMessages((prev) => [
                    ...prev,
                    {
                        id: nextId(),
                        role: 'assistant',
                        text: cap != null
                            ? `Session spend: $${usage.costUsd.toFixed(5)} / $${cap.toFixed(2)} cap`
                            : `Session spend: $${usage.costUsd.toFixed(5)} (no cap set for this personality)`,
                    },
                ]);
                break;
            }
            case 'readonly': {
                const next = !readonlyMode;
                setReadonlyMode(next);
                setStatusMsg(`readonly: ${next ? 'on' : 'off'}`);
                pushTimeline(next ? 'warning' : 'info', `readonly mode ${next ? 'enabled' : 'disabled'}`);
                break;
            }
            case 'verbose': {
                verboseRef.current = !verboseRef.current;
                setVerboseDisplay(verboseRef.current);
                setStatusMsg(`verbose: ${verboseRef.current ? 'on' : 'off'}`);
                break;
            }
            case 'details':
                handleDetailsCommand(args);
                break;
            case 'skin': {
                const sub = args[0] ?? '';
                if (sub === '' || sub === 'list') {
                    const effective = pickEffectiveSkin(userPinnedSkin);
                    const lines = BUILTIN_SKIN_NAMES.map((name) => {
                        const marker = name === effective ? '*' : ' ';
                        return `  ${marker} ${name.padEnd(10)} ${BUILTIN_SKINS[name].description}`;
                    });
                    const source = userPinnedSkin ? `pinned by user` : `engine default`;
                    setMessages((prev) => [
                        ...prev,
                        {
                            id: nextId(),
                            role: 'assistant',
                            text: `Skins:\n${lines.join('\n')}\nActive: ${effective} (${source})`,
                        },
                    ]);
                    break;
                }
                if (sub === 'reset') {
                    setUserPinnedSkin(null);
                    const effective = applyTokensFor(null);
                    setStatusMsg(`[skin: ${effective} — user pin cleared]`);
                    break;
                }
                if (!BUILTIN_SKINS[sub]) {
                    setStatusMsg(`Unknown skin: ${sub} — /skin list to see options`);
                    break;
                }
                setUserPinnedSkin(sub);
                applyTokensFor(sub);
                setStatusMsg(`[skin: ${sub}]`);
                break;
            }
            case 'tools': {
                if (!inventory) {
                    setStatusMsg('[no tool inventory available]');
                    break;
                }
                const lines = inventory.tools.map((g) => `${g.toolset.padEnd(16)} ${g.names.join(', ')}`);
                setMessages((prev) => [
                    ...prev,
                    {
                        id: nextId(),
                        role: 'assistant',
                        text: `Tools (${inventory.totalTools} total):\n${lines.join('\n')}`,
                    },
                ]);
                break;
            }
            case 'skills': {
                if (!inventory || inventory.skills.length === 0) {
                    setStatusMsg('[no skills installed]');
                    break;
                }
                setMessages((prev) => [
                    ...prev,
                    {
                        id: nextId(),
                        role: 'assistant',
                        text: `Skills (${inventory.skills.length}):\n${inventory.skills.join('\n')}`,
                    },
                ]);
                break;
            }
            case 'exit':
            case 'quit':
                exit();
                break;
            default:
                setStatusMsg(`Unknown command /${name} — type /help`);
        }
    };
    const handleDetailsCommand = (args) => {
        const VALID_SECTIONS = ['thinking', 'tools', 'subagents', 'activity'];
        const VALID_MODES = ['hidden', 'collapsed', 'expanded'];
        if (args.length === 0) {
            setDetails((d) => {
                const next = d.global === 'collapsed' ? 'expanded' : d.global === 'expanded' ? 'hidden' : 'collapsed';
                return { ...d, global: next };
            });
            return;
        }
        const first = args[0] ?? '';
        if (VALID_MODES.includes(first)) {
            setDetails((d) => ({ ...d, global: first }));
            return;
        }
        if (VALID_SECTIONS.includes(first)) {
            const section = first;
            const second = args[1];
            if (second === 'reset') {
                setDetails((d) => ({ ...d, [section]: null }));
                return;
            }
            if (second && VALID_MODES.includes(second)) {
                setDetails((d) => ({ ...d, [section]: second }));
                return;
            }
            setStatusMsg(`Usage: /details ${section} <hidden|collapsed|expanded|reset>`);
            return;
        }
        setStatusMsg('Usage: /details [<section>] [<mode>]');
    };
    if (clarifyRequest) {
        const req = clarifyRequest;
        return (_jsx(SkinContext.Provider, { value: tokens, children: _jsx(ClarifyModal, { request: req, onAnswer: (answer) => {
                    setClarifyRequest(null);
                    void bridge.clarifyBridge?.respond({
                        requestId: req.requestId,
                        answer,
                        source: 'user',
                    });
                }, onCancel: () => {
                    setClarifyRequest(null);
                    void bridge.clarifyBridge?.respond({
                        requestId: req.requestId,
                        answer: '',
                        source: 'cancel',
                    });
                } }) }));
    }
    if (modal === 'sessions') {
        return (_jsx(SkinContext.Provider, { value: tokens, children: _jsx(SessionPickerModal, { onSelect: (s) => {
                    setSessionKey(s.key);
                    setMessages([]);
                    setCompletedTools([]);
                    setPersonality(s.personalityId ?? personality);
                    setModal(null);
                    setStatusMsg(`[resumed: ${s.title ?? s.key}]`);
                }, onCancel: () => setModal(null) }) }));
    }
    if (modal === 'models') {
        return (_jsx(SkinContext.Provider, { value: tokens, children: _jsx(ModelPickerModal, { current: currentModel, onSelect: async (entry) => {
                    setModal(null);
                    if (rebuildLoop) {
                        setStatusMsg(`[switching model to ${entry.id}…]`);
                        try {
                            const newLoop = await rebuildLoop(entry.id);
                            bridge.replaceLoop(newLoop);
                            setCurrentModel(entry.id);
                            setStatusMsg(`[model: ${entry.id}]`);
                        }
                        catch (err) {
                            setStatusMsg(`[model switch failed: ${err instanceof Error ? err.message : String(err)}]`);
                        }
                    }
                    else {
                        setCurrentModel(entry.id);
                        setStatusMsg(`[model: ${entry.id} — restart to persist; edit ~/.ethos/config.yaml to make permanent]`);
                    }
                }, onCancel: () => setModal(null) }) }));
    }
    return (_jsxs(SkinContext.Provider, { value: tokens, children: [_jsx(Static, { items: hudSnapshots, children: (snap) => (_jsxs(Box, { flexDirection: "column", children: [_jsx(ConsoleHeader, { model: snap.model, personality: snap.personality, sessionKey: snap.sessionKey, accentColor: snap.accentColor }), _jsxs(Box, { flexDirection: "row", marginBottom: 1, children: [showIdentityPane && (_jsx(Box, { width: 28, children: _jsx(IdentityPanel, { personality: snap.personality, status: "idle", delegationCount: 0, accentColor: snap.accentColor }) })), _jsxs(Box, { flexGrow: 1, flexDirection: "column", children: [_jsx(ContextPanel, { activeTools: [], completedTools: [], queueDepth: 0, messageCount: 0, pendingPatchCount: 0 }), _jsx(SafetyLane, { readonlyMode: false, tags: [] }), _jsx(FileActivityPanel, { entries: [] })] })] })] }, snap.id)) }), _jsx(Static, { items: messages, children: (msg) => _jsx(ChatRow, { message: msg, accentColor: accentColor }, msg.id) }), _jsxs(Box, { flexDirection: "column", children: [showSplash && inventory ? (_jsx(Splash, { model: currentModel, personality: personality, sessionKey: sessionKey, accentColor: accentColor, inventory: inventory })) : (_jsx(StreamingRow, { text: streamingText, accentColor: accentColor })), thinkingText && (_jsx(AccordionSection, { title: "thinking", mode: resolveMode(details.thinking, details.global), children: _jsx(ThinkingPane, { text: thinkingText }) })), (activeTools.length > 0 || completedTools.length > 0) && (_jsx(AccordionSection, { title: "tools", mode: resolveMode(details.tools, details.global), count: activeTools.length + completedTools.length, children: _jsx(ToolSpinner, { activeTools: activeTools, completedTools: completedTools }) })), resolveMode(details.activity, details.global) !== 'hidden' &&
                        timelineEvents.length > 0 && (_jsx(AccordionSection, { title: "activity", mode: resolveMode(details.activity, details.global), count: timelineEvents.length, children: _jsx(ExecutionTimeline, { events: timelineEvents, focused: focusPane === 'timeline' }) })), delegations.length > 0 && (_jsx(AccordionSection, { title: "subagents", mode: resolveMode(details.subagents, details.global), count: delegations.length, children: _jsx(SubagentsPane, { delegations: delegations }) })), showKeymap && (_jsx(Box, { marginBottom: 1, children: _jsx(KeymapOverlay, { focusPane: focusPane, running: running }) })), statusMsg && (_jsx(Box, { marginBottom: 1, children: _jsx(Text, { dimColor: true, children: statusMsg }) })), completionVisible && (_jsx(CompletionPanel, { matches: completionMatches, selectedIndex: completionIndex })), _jsx(InputBox, { value: input, disabled: running, isActive: modal === null && clarifyRequest === null && !showKeymap && focusPane === 'input', onChange: setInput, onSubmit: handleSubmit, onTabComplete: applyCompletion, onArrowUp: () => {
                            if (completionVisible) {
                                setCompletionIndex((i) => Math.max(0, i - 1));
                                return;
                            }
                            if (history.length === 0)
                                return;
                            if (historyIndex === null) {
                                setHistoryDraft(input);
                                const nextIndex = history.length - 1;
                                setHistoryIndex(nextIndex);
                                setInput(history[nextIndex] ?? '');
                                return;
                            }
                            const nextIndex = Math.max(0, historyIndex - 1);
                            setHistoryIndex(nextIndex);
                            setInput(history[nextIndex] ?? '');
                        }, onArrowDown: () => {
                            if (completionVisible) {
                                setCompletionIndex((i) => Math.min(completionMatches.length - 1, i + 1));
                                return;
                            }
                            if (historyIndex === null)
                                return;
                            const nextIndex = historyIndex + 1;
                            if (nextIndex >= history.length) {
                                setHistoryIndex(null);
                                setInput(historyDraft);
                                return;
                            }
                            setHistoryIndex(nextIndex);
                            setInput(history[nextIndex] ?? '');
                        }, onEscape: () => {
                            if (completionVisible) {
                                setInput('');
                                return;
                            }
                            setHistoryIndex(null);
                        } }), _jsx(StatusBar, { model: currentModel, personality: personality, accentColor: accentColor, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd, status: agentStatus, currentTool: currentTool, elapsedSecs: agentStatus === 'thinking' ? turnElapsed : undefined, readonlyMode: readonlyMode, backgroundCount: delegations.filter((d) => d.status === 'pending').length, updateStatus: updateStatus, budgetState: budgetCapUsd != null
                            ? { spent: usage.costUsd, cap: budgetCapUsd }
                            : null })] })] }));
}
