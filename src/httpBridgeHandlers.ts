/**
 * HTTP Bridge — Endpoint handler functions.
 *
 * Pure functions that receive parsed request data and a HandlerContext,
 * then mutate agent state and dispatch webview messages. Each handler
 * corresponds to one HTTP bridge endpoint:
 *   /prompt-start  → handlePromptStart
 *   /tool-start    → handleToolStart
 *   /tool-done     → handleToolDone
 *   /agent-stop    → handleAgentStop
 *
 * HTTP agents reuse the existing AgentState interface with terminalRef: null,
 * matching the terminal-less agent pattern used by the JSONL pipeline for Kiro.
 *
 * (Requirements: 3.1, 3.2, 3.5, 3.6, 4.1, 4.2, 4.3, 5.1, 5.2, 6.1, 6.2,
 *  8.1, 8.2, 8.4, 8.5)
 */

import type * as vscode from 'vscode';
import type { AgentState } from './types.js';
import { mapKiroToolName } from './httpToolNameMap.js';
import { formatToolStatus, PERMISSION_EXEMPT_TOOLS } from './transcriptParser.js';
import { cancelWaitingTimer, cancelPermissionTimer, startPermissionTimer } from './timerManager.js';
import { TOOL_DONE_DELAY_MS, HTTP_AGENT_INACTIVITY_TIMEOUT_MS } from './constants.js';

// ── Request / Response types ────────────────────────────────────────────────
// Exported so the server module can reference them for JSON validation.

/** POST /tool-start request body. */
export interface ToolStartRequest {
	tool: string;
}

/** POST /tool-start response body. */
export interface ToolStartResponse {
	toolId: string;
}

/** POST /tool-done request body. */
export interface ToolDoneRequest {
	toolId: string;
}

// ── Handler context ─────────────────────────────────────────────────────────

/**
 * Shared context passed to every handler. Holds references to the agent map,
 * ID counters, webview accessor, timer maps, and the HTTP-specific agent ref.
 */
export interface HandlerContext {
	agents: Map<number, AgentState>;
	nextAgentIdRef: { current: number };
	activeAgentIdRef: { current: number | null };
	getWebview: () => vscode.Webview | undefined;
	persistAgents: () => void;
	onTerminalLessTurnEnd: (agentId: number) => void;
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
	/** Tracks the current HTTP-driven agent for this workspace. */
	httpAgentIdRef: { current: number | null };
	/** Inactivity timer — auto-stops the HTTP agent if no activity arrives. */
	httpInactivityTimerRef: { current: ReturnType<typeof setTimeout> | null };
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Resets the HTTP agent inactivity timer. Called on every activity (prompt start,
 * tool start, tool done). If no activity arrives within HTTP_AGENT_INACTIVITY_TIMEOUT_MS,
 * the agent is auto-stopped as a safety net for missed agentStop events.
 */
function resetHttpInactivityTimer(ctx: HandlerContext): void {
	if (ctx.httpInactivityTimerRef.current !== null) {
		clearTimeout(ctx.httpInactivityTimerRef.current);
	}
	ctx.httpInactivityTimerRef.current = setTimeout(() => {
		ctx.httpInactivityTimerRef.current = null;
		if (ctx.httpAgentIdRef.current !== null) {
			console.log(`[Pixel Agents] HTTP agent ${ctx.httpAgentIdRef.current}: inactivity timeout, auto-stopping`);
			handleAgentStop(ctx);
		}
	}, HTTP_AGENT_INACTIVITY_TIMEOUT_MS);
}

/**
 * Creates a new HTTP agent with terminalRef: null and sentinel values for
 * projectDir / jsonlFile (not used by HTTP agents but required by AgentState).
 * Posts `agentCreated` to the webview and sets the active agent ref.
 * (Req 8.1 — terminalRef null; Req 5.1 — agent creation)
 */
function createHttpAgent(ctx: HandlerContext): AgentState {
	const id = ctx.nextAgentIdRef.current++;
	const agent: AgentState = {
		id,
		terminalRef: null,
		projectDir: 'http-bridge',   // sentinel — not used for HTTP agents
		jsonlFile: 'http-bridge',    // sentinel — not used for HTTP agents
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
	};

	ctx.agents.set(id, agent);
	ctx.activeAgentIdRef.current = id;
	ctx.httpAgentIdRef.current = id;
	ctx.persistAgents();

	console.log(`[Pixel Agents] Agent ${id}: created HTTP bridge agent`);
	// Req 8.5 — getWebview() may return undefined; optional chaining skips postMessage.
	ctx.getWebview()?.postMessage({ type: 'agentCreated', id });

	return agent;
}

/**
 * Returns the existing HTTP agent, or creates one if it doesn't exist.
 * Used by handleToolStart to ensure an agent is present before registering tools.
 */
function ensureHttpAgent(ctx: HandlerContext): AgentState {
	if (ctx.httpAgentIdRef.current !== null) {
		const existing = ctx.agents.get(ctx.httpAgentIdRef.current);
		if (existing) {
			return existing;
		}
	}
	// Agent doesn't exist (or was cleaned up) — create a fresh one.
	return createHttpAgent(ctx);
}

// ── Endpoint handlers ───────────────────────────────────────────────────────

/**
 * POST /prompt-start — Creates or reactivates the HTTP agent.
 *
 * If no HTTP agent exists, creates one and posts `agentCreated`.
 * If the agent exists and is waiting, clears the waiting state and posts
 * `agentStatus: 'active'`. Sets activeAgentIdRef to the HTTP agent.
 * (Req 5.1 — create new agent; Req 5.2 — reactivate waiting agent)
 */
export function handlePromptStart(ctx: HandlerContext): void {
	resetHttpInactivityTimer(ctx);
	const existingId = ctx.httpAgentIdRef.current;

	if (existingId !== null) {
		const agent = ctx.agents.get(existingId);
		if (agent) {
			// Agent exists — reactivate if waiting (Req 5.2)
			ctx.activeAgentIdRef.current = agent.id;
			if (agent.isWaiting) {
				agent.isWaiting = false;
				cancelWaitingTimer(agent.id, ctx.waitingTimers);
				console.log(`[Pixel Agents] Agent ${agent.id}: HTTP bridge reactivated`);
				ctx.getWebview()?.postMessage({ type: 'agentStatus', id: agent.id, status: 'active' });
			}
			return;
		}
	}

	// No agent or stale ref — create a new one (Req 5.1)
	createHttpAgent(ctx);
}

/**
 * POST /tool-start — Registers a new tool on the HTTP agent.
 *
 * Ensures an HTTP agent exists (creates one if needed, same as prompt-start).
 * Maps the Kiro tool name via mapKiroToolName(), generates a unique toolId via
 * crypto.randomUUID(), calls formatToolStatus() for the display string, adds to
 * activeToolIds / activeToolStatuses / activeToolNames, posts `agentToolStart`.
 * Starts a permission timer for non-exempt tools (Req 8.4).
 * Returns { toolId } so the hook can correlate tool-done events (Req 3.5, 3.6).
 */
export function handleToolStart(ctx: HandlerContext, body: ToolStartRequest): ToolStartResponse {
	resetHttpInactivityTimer(ctx);
	const agent = ensureHttpAgent(ctx);
	const webview = ctx.getWebview();

	// Cancel waiting state — agent is actively working (Req 3.1)
	cancelWaitingTimer(agent.id, ctx.waitingTimers);
	agent.isWaiting = false;
	agent.hadToolsInTurn = true;

	// Map Kiro tool name → Claude Code equivalent for display (Req 3.3, 3.4)
	const mappedName = mapKiroToolName(body.tool);
	const toolId = crypto.randomUUID();
	const status = formatToolStatus(mappedName, {});

	// Track the tool in agent state
	agent.activeToolIds.add(toolId);
	agent.activeToolStatuses.set(toolId, status);
	agent.activeToolNames.set(toolId, mappedName);

	console.log(`[Pixel Agents] Agent ${agent.id} HTTP tool start: ${toolId} ${status}`);
	webview?.postMessage({ type: 'agentToolStart', id: agent.id, toolId, status });

	// Start permission timer for non-exempt tools (Req 8.4).
	// HTTP agents always use timer-based permission detection since there is
	// no terminal to observe explicit permission records from.
	if (!PERMISSION_EXEMPT_TOOLS.has(mappedName)) {
		startPermissionTimer(agent.id, ctx.agents, ctx.permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
	}

	return { toolId };
}

/**
 * POST /tool-done — Completes a tool on the HTTP agent.
 *
 * Looks up toolId in the agent's activeToolIds. If not found, returns silently
 * (idempotent — Req 4.2). Otherwise removes from active sets and posts
 * `agentToolDone` with TOOL_DONE_DELAY_MS delay to match JSONL pipeline behavior.
 * When all tools complete, resets hadToolsInTurn (Req 4.3).
 */
export function handleToolDone(ctx: HandlerContext, body: ToolDoneRequest): void {
	resetHttpInactivityTimer(ctx);
	if (ctx.httpAgentIdRef.current === null) {
		return; // No HTTP agent — nothing to do (idempotent)
	}
	const agent = ctx.agents.get(ctx.httpAgentIdRef.current);
	if (!agent) {
		return; // Agent was cleaned up — nothing to do (idempotent)
	}

	// Idempotent: unknown toolId is silently ignored (Req 4.2)
	if (!agent.activeToolIds.has(body.toolId)) {
		return;
	}

	// Remove tool from active tracking (Req 4.1)
	agent.activeToolIds.delete(body.toolId);
	agent.activeToolStatuses.delete(body.toolId);
	agent.activeToolNames.delete(body.toolId);

	console.log(`[Pixel Agents] Agent ${agent.id} HTTP tool done: ${body.toolId}`);

	// Post agentToolDone with delay matching JSONL pipeline behavior
	const agentId = agent.id;
	const toolId = body.toolId;
	const webview = ctx.getWebview();
	setTimeout(() => {
		webview?.postMessage({ type: 'agentToolDone', id: agentId, toolId });
	}, TOOL_DONE_DELAY_MS);

	// All tools completed — allow text-idle timer as fallback (Req 4.3)
	if (agent.activeToolIds.size === 0) {
		agent.hadToolsInTurn = false;
	}
}

/**
 * POST /agent-stop — Ends the HTTP agent's turn.
 *
 * Clears all active tool state (activeToolIds, activeToolStatuses, activeToolNames,
 * activeSubagentToolIds, activeSubagentToolNames), cancels waiting/permission timers,
 * posts `agentToolsClear` and `agentStatus: 'waiting'`, sets isWaiting = true,
 * permissionSent = false, hadToolsInTurn = false, then calls onTerminalLessTurnEnd
 * to schedule cleanup after TERMINALLESS_CLEANUP_DELAY_MS.
 * (Req 6.1 — clear state; Req 6.2 — clear timers; Req 8.2 — schedule cleanup)
 */
export function handleAgentStop(ctx: HandlerContext): void {
	// Clear inactivity timer — agent is explicitly stopping
	if (ctx.httpInactivityTimerRef.current !== null) {
		clearTimeout(ctx.httpInactivityTimerRef.current);
		ctx.httpInactivityTimerRef.current = null;
	}
	if (ctx.httpAgentIdRef.current === null) {
		return; // No HTTP agent — nothing to do
	}
	const agent = ctx.agents.get(ctx.httpAgentIdRef.current);
	if (!agent) {
		return; // Agent was cleaned up — nothing to do
	}

	const webview = ctx.getWebview();

	// Cancel all timers (Req 6.2)
	cancelWaitingTimer(agent.id, ctx.waitingTimers);
	cancelPermissionTimer(agent.id, ctx.permissionTimers);

	// Clear all active tool state (Req 6.1)
	agent.activeToolIds.clear();
	agent.activeToolStatuses.clear();
	agent.activeToolNames.clear();
	agent.activeSubagentToolIds.clear();
	agent.activeSubagentToolNames.clear();

	// Set waiting state
	agent.isWaiting = true;
	agent.permissionSent = false;
	agent.hadToolsInTurn = false;

	console.log(`[Pixel Agents] Agent ${agent.id}: HTTP bridge agent stopped`);
	webview?.postMessage({ type: 'agentToolsClear', id: agent.id });
	webview?.postMessage({ type: 'agentStatus', id: agent.id, status: 'waiting' });

	// Schedule cleanup — matches terminal-less agent behavior (Req 8.2)
	ctx.onTerminalLessTurnEnd(agent.id);
}
