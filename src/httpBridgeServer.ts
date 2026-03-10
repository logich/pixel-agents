/**
 * HTTP Bridge — Server lifecycle and request routing.
 *
 * Creates a local HTTP server on 127.0.0.1 (loopback only) that receives
 * JSON payloads from Kiro hooks via curl. The server writes its port to
 * ~/.pixel-agents/kiro-port so hooks can discover it at runtime.
 *
 * Request routing dispatches to handler functions in httpBridgeHandlers.ts.
 * The server enforces body size limits, validates JSON, and returns
 * appropriate HTTP error codes for malformed/unknown requests.
 *
 * (Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2,
 *  10.1, 10.2, 10.3, 10.5, 11.1, 11.2, 11.3)
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type * as vscode from 'vscode';
import type { AgentState } from './types.js';
import type { HandlerContext, ToolStartRequest, ToolDoneRequest } from './httpBridgeHandlers.js';
import { handlePromptStart, handleToolStart, handleToolDone, handleAgentStop } from './httpBridgeHandlers.js';
import {
	HTTP_BRIDGE_PORT_FILE_DIR,
	HTTP_BRIDGE_PORT_FILE_NAME,
	HTTP_BRIDGE_MAX_BODY_BYTES,
} from './constants.js';

// ── Exported interfaces ─────────────────────────────────────────────────────

/**
 * Dependencies injected by PixelAgentsViewProvider when creating the server.
 * These are shared references into the provider's agent state management.
 */
export interface HttpBridgeServerDeps {
	nextAgentIdRef: { current: number };
	agents: Map<number, AgentState>;
	activeAgentIdRef: { current: number | null };
	getWebview: () => vscode.Webview | undefined;
	persistAgents: () => void;
	onTerminalLessTurnEnd: (agentId: number) => void;
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
}

/**
 * Public interface for the HTTP bridge server.
 * start() begins listening; stop() tears down and removes the port file.
 */
export interface HttpBridgeServer {
	/** Start listening on an available localhost port. Writes port file. */
	start(): Promise<void>;
	/** Stop listening. Removes port file. */
	stop(): Promise<void>;
	/** The port the server is listening on, or null if not started. */
	readonly port: number | null;
}

// ── Internal helpers ────────────────────────────────────────────────────────

/** Full path to the port file: ~/.pixel-agents/kiro-port */
const PORT_FILE_PATH = path.join(os.homedir(), HTTP_BRIDGE_PORT_FILE_DIR, HTTP_BRIDGE_PORT_FILE_NAME);

/** Full path to the port file directory: ~/.pixel-agents/ */
const PORT_FILE_DIR_PATH = path.join(os.homedir(), HTTP_BRIDGE_PORT_FILE_DIR);

/** Valid POST endpoint paths and their route keys. */
const VALID_PATHS = new Set(['/prompt-start', '/tool-start', '/tool-done', '/agent-stop']);

/**
 * Send a JSON error response with the given HTTP status code.
 * Used for 400, 404, 405, 413, and 500 responses.
 */
function sendJsonError(res: http.ServerResponse, statusCode: number, message: string): void {
	const body = JSON.stringify({ error: message });
	res.writeHead(statusCode, { 'Content-Type': 'application/json' });
	res.end(body);
}

/**
 * Send a JSON success response (HTTP 200) with an optional body.
 * If no body is provided, sends `{}`.
 */
function sendJsonOk(res: http.ServerResponse, body?: unknown): void {
	const payload = JSON.stringify(body ?? {});
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(payload);
}

/**
 * Collect the full request body, enforcing HTTP_BRIDGE_MAX_BODY_BYTES.
 * Resolves with the raw body string, or rejects if the limit is exceeded.
 * (Req 11.3 — reject oversized bodies before parsing)
 */
function collectBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let totalBytes = 0;

		req.on('data', (chunk: Buffer) => {
			totalBytes += chunk.length;
			if (totalBytes > HTTP_BRIDGE_MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error('body_too_large'));
				return;
			}
			chunks.push(chunk);
		});

		req.on('end', () => {
			resolve(Buffer.concat(chunks).toString('utf-8'));
		});

		req.on('error', (err) => {
			reject(err);
		});
	});
}

/**
 * Write the port number to the port file at ~/.pixel-agents/kiro-port.
 * Creates the directory if it doesn't exist (Req 1.6).
 * Sets file permissions to 0o600 — owner read/write only (Req 11.2).
 * Port is written as a plain text integer with no trailing whitespace (Req 2.1).
 */
function writePortFile(port: number): void {
	fs.mkdirSync(PORT_FILE_DIR_PATH, { recursive: true });
	fs.writeFileSync(PORT_FILE_PATH, String(port), { mode: 0o600 });
}

/**
 * Remove the port file. Ignores errors if the file is already gone.
 * Called during stop() to clean up (Req 1.3).
 */
function removePortFile(): void {
	try {
		fs.unlinkSync(PORT_FILE_PATH);
	} catch (_err) {
		// File already removed or never written — safe to ignore.
	}
}

// ── Factory function ────────────────────────────────────────────────────────

/**
 * Create an HTTP bridge server instance.
 *
 * The returned object exposes start(), stop(), and a port getter.
 * The server binds to 127.0.0.1:0 (OS-assigned port, loopback only — Req 1.5, 11.1).
 * On start, writes the port to ~/.pixel-agents/kiro-port (Req 1.2, 2.1).
 * On stop, removes the port file (Req 1.3).
 * On bind failure, logs the error and resolves — extension continues without
 * HTTP bridge functionality (Req 1.4).
 */
export function createHttpBridgeServer(deps: HttpBridgeServerDeps): HttpBridgeServer {
	let server: http.Server | null = null;
	let currentPort: number | null = null;

	// Internal ref tracking the HTTP-driven agent for this workspace.
	// Not passed in from deps — created here per the design doc.
	const httpAgentIdRef: { current: number | null } = { current: null };

	// Inactivity timer ref for auto-stopping stale HTTP agents.
	const httpInactivityTimerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };

	// Build the HandlerContext from deps + internal httpAgentIdRef.
	const ctx: HandlerContext = {
		agents: deps.agents,
		nextAgentIdRef: deps.nextAgentIdRef,
		activeAgentIdRef: deps.activeAgentIdRef,
		getWebview: deps.getWebview,
		persistAgents: deps.persistAgents,
		onTerminalLessTurnEnd: deps.onTerminalLessTurnEnd,
		waitingTimers: deps.waitingTimers,
		permissionTimers: deps.permissionTimers,
		httpAgentIdRef,
		httpInactivityTimerRef,
	};

	/**
	 * Route a parsed request to the appropriate handler.
	 * Validates method, path, and request-specific fields before dispatching.
	 * Returns the response body (or undefined for void handlers).
	 */
	function routeRequest(urlPath: string, body: unknown): unknown {
		switch (urlPath) {
			case '/prompt-start':
				handlePromptStart(ctx);
				return undefined;

			case '/tool-start': {
				// Validate required 'tool' field (Req 3.2)
				const tsBody = body as Record<string, unknown>;
				if (typeof tsBody?.tool !== 'string') {
					throw new ValidationError('Missing required field: tool');
				}
				return handleToolStart(ctx, tsBody as unknown as ToolStartRequest);
			}

			case '/tool-done': {
				// Validate required 'toolId' field
				const tdBody = body as Record<string, unknown>;
				if (typeof tdBody?.toolId !== 'string') {
					throw new ValidationError('Missing required field: toolId');
				}
				handleToolDone(ctx, tdBody as unknown as ToolDoneRequest);
				return undefined;
			}

			case '/agent-stop':
				handleAgentStop(ctx);
				return undefined;

			default:
				// Should not reach here — VALID_PATHS check happens before routing.
				return undefined;
		}
	}

	/**
	 * Main request handler for the HTTP server.
	 * Collects body, parses JSON, routes to handlers, sends responses.
	 * Handles all error cases with appropriate HTTP status codes.
	 */
	async function onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const urlPath = req.url ?? '/';

		// Req 10.2 — unknown endpoint path → 404
		if (!VALID_PATHS.has(urlPath)) {
			sendJsonError(res, 404, 'Not found');
			return;
		}

		// Req 10.5 — wrong HTTP method → 405 (all endpoints are POST-only)
		if (req.method !== 'POST') {
			sendJsonError(res, 405, 'Method not allowed');
			return;
		}

		try {
			// Collect body with size limit enforcement (Req 11.3)
			let rawBody: string;
			try {
				rawBody = await collectBody(req);
			} catch (err) {
				if (err instanceof Error && err.message === 'body_too_large') {
					sendJsonError(res, 413, 'Request body too large');
					return;
				}
				throw err;
			}

			// Parse JSON body (Req 10.1 — malformed JSON → 400)
			let body: unknown;
			try {
				body = rawBody.length > 0 ? JSON.parse(rawBody) : {};
			} catch (_parseErr) {
				sendJsonError(res, 400, 'Invalid JSON');
				return;
			}

			// Route to handler and send response
			const result = routeRequest(urlPath, body);
			sendJsonOk(res, result);

		} catch (err) {
			// Req 3.2 — missing required field → 400
			if (err instanceof ValidationError) {
				sendJsonError(res, 400, err.message);
				return;
			}

			// Req 10.3 — handler throws unexpected error → 500, log, continue
			console.error('[Pixel Agents] HTTP bridge handler error:', err);
			sendJsonError(res, 500, 'Internal server error');
		}
	}

	return {
		get port(): number | null {
			return currentPort;
		},

		start(): Promise<void> {
			return new Promise((resolve) => {
				server = http.createServer((req, res) => {
					// Fire-and-forget — errors are caught inside onRequest.
					void onRequest(req, res);
				});

				// Req 1.4 — bind failure: log error, resolve (don't throw).
				// Extension continues without HTTP bridge.
				server.on('error', (err) => {
					console.error('[Pixel Agents] HTTP bridge failed to start:', err);
					server = null;
					currentPort = null;
					resolve();
				});

				// Req 1.5, 11.1 — bind to 127.0.0.1 loopback only.
				// Port 0 lets the OS assign an available port (Req 1.1).
				server.listen(0, '127.0.0.1', () => {
					const addr = server?.address();
					if (addr && typeof addr !== 'string') {
						currentPort = addr.port;

						// Req 1.2, 2.1, 2.2 — write port file (plain integer, no trailing whitespace).
						// Req 1.6 — create directory if missing.
						// Req 11.2 — file mode 0o600.
						try {
							writePortFile(currentPort);
							console.log(`[Pixel Agents] HTTP bridge listening on 127.0.0.1:${currentPort}`);
						} catch (err) {
							// Port file write failed — log and shut down server.
							// Extension continues without HTTP bridge (Req 1.4 spirit).
							console.error('[Pixel Agents] HTTP bridge failed to write port file:', err);
							server?.close();
							server = null;
							currentPort = null;
						}
					}
					resolve();
				});
			});
		},

		stop(): Promise<void> {
			return new Promise((resolve) => {
				// Req 1.3 — remove port file on stop.
				removePortFile();
				currentPort = null;

				if (!server) {
					resolve();
					return;
				}

				server.close(() => {
					server = null;
					resolve();
				});
			});
		},
	};
}

// ── Validation error ────────────────────────────────────────────────────────

/**
 * Thrown by routeRequest when a required field is missing from the request body.
 * Caught by onRequest to return HTTP 400 with the validation message.
 */
class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ValidationError';
	}
}
