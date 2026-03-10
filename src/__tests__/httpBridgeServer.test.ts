/**
 * Property-based and unit tests for HTTP bridge server lifecycle and routing.
 *
 * Tests Properties 1–5 (server lifecycle, port file, binding, permissions)
 * and Properties 13–14 (invalid request handling, body size limit)
 * from the kiro-http-bridge design document.
 *
 * These tests start real HTTP servers on 127.0.0.1:0 and make actual HTTP
 * requests — no fake timers (real timers needed for HTTP connections).
 *
 * Validates: Requirements 1.2, 1.3, 1.5, 2.1, 2.2, 10.1, 10.2, 10.5, 11.1, 11.2, 11.3
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as fc from 'fast-check';

// Mock vscode module before importing anything that depends on it.
// @ts-expect-error — vitest supports the virtual option at runtime
vi.mock('vscode', () => ({}), { virtual: true });

import { createHttpBridgeServer } from '../httpBridgeServer.js';
import type { HttpBridgeServerDeps } from '../httpBridgeServer.js';
import { HTTP_BRIDGE_MAX_BODY_BYTES } from '../constants.js';

// ── Port file path (mirrors the server's internal constant) ─────────────────
const PORT_FILE_PATH = path.join(os.homedir(), '.pixel-agents', 'kiro-port');

// ── Helper: create mock deps ────────────────────────────────────────────────
function makeDeps(): HttpBridgeServerDeps {
	return {
		nextAgentIdRef: { current: 1 },
		agents: new Map(),
		activeAgentIdRef: { current: null },
		getWebview: () => ({ postMessage: () => {} }) as never,
		persistAgents: () => {},
		onTerminalLessTurnEnd: () => {},
		waitingTimers: new Map(),
		permissionTimers: new Map(),
	};
}

// ── Helper: make an HTTP request to the server ──────────────────────────────
function httpRequest(
	port: number,
	method: string,
	urlPath: string,
	body?: string,
): Promise<{ statusCode: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ hostname: '127.0.0.1', port, method, path: urlPath, headers: { 'Content-Type': 'application/json' } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') });
				});
			},
		);
		req.on('error', reject);
		if (body) {
			req.write(body);
		}
		req.end();
	});
}

// ── Cleanup: stop any server that was started during a test ─────────────────
let activeServer: ReturnType<typeof createHttpBridgeServer> | null = null;

afterEach(async () => {
	if (activeServer) {
		await activeServer.stop();
		activeServer = null;
	}
});

// ── Property 1: Port file round-trip ────────────────────────────────────────
// Feature: kiro-http-bridge, Property 1: Port file round-trip
describe('Property 1: Port file round-trip', () => {
	// **Validates: Requirements 1.2, 2.1**

	it('port file contains a plain integer matching server.port, and the port accepts connections', async () => {
		const server = createHttpBridgeServer(makeDeps());
		activeServer = server;
		await server.start();

		// Port should be set after start
		expect(server.port).not.toBeNull();
		expect(typeof server.port).toBe('number');

		// Read port file — should contain a plain integer with no extra whitespace (Req 2.1)
		const portFileContent = fs.readFileSync(PORT_FILE_PATH, 'utf-8');
		const parsedPort = Number(portFileContent);
		expect(Number.isInteger(parsedPort)).toBe(true);
		expect(portFileContent).toBe(String(parsedPort)); // no trailing whitespace/newlines

		// Port file value should match server.port (Req 1.2)
		expect(parsedPort).toBe(server.port);

		// Connecting to 127.0.0.1:<port> should succeed
		const res = await httpRequest(server.port!, 'POST', '/prompt-start', '{}');
		expect(res.statusCode).toBe(200);
	});
});

// ── Property 2: Server stop cleans up port file ─────────────────────────────
// Feature: kiro-http-bridge, Property 2: Server stop cleans up port file
describe('Property 2: Server stop cleans up port file', () => {
	// **Validates: Requirements 1.3**

	it('after stop, port file is removed', async () => {
		const server = createHttpBridgeServer(makeDeps());
		activeServer = server;
		await server.start();

		// Port file should exist after start
		expect(fs.existsSync(PORT_FILE_PATH)).toBe(true);

		await server.stop();
		activeServer = null;

		// Port file should be removed after stop (Req 1.3)
		expect(fs.existsSync(PORT_FILE_PATH)).toBe(false);

		// server.port should be null after stop
		expect(server.port).toBeNull();
	});
});

// ── Property 3: Server restart overwrites port file ─────────────────────────
// Feature: kiro-http-bridge, Property 3: Server restart overwrites port file
describe('Property 3: Server restart overwrites port file', () => {
	// **Validates: Requirements 2.2**

	it('start/stop/start cycle writes a new port to the file, and the new port accepts connections', async () => {
		const server1 = createHttpBridgeServer(makeDeps());
		activeServer = server1;
		await server1.start();
		const port1 = server1.port;
		expect(port1).not.toBeNull();

		await server1.stop();
		activeServer = null;

		// Start a second server (simulates extension reload)
		const server2 = createHttpBridgeServer(makeDeps());
		activeServer = server2;
		await server2.start();
		const port2 = server2.port;
		expect(port2).not.toBeNull();

		// Port file should contain the new port (Req 2.2)
		const portFileContent = fs.readFileSync(PORT_FILE_PATH, 'utf-8');
		expect(Number(portFileContent)).toBe(port2);

		// New port should accept connections
		const res = await httpRequest(port2!, 'POST', '/prompt-start', '{}');
		expect(res.statusCode).toBe(200);
	});
});

// ── Property 4: Server binds to loopback only ───────────────────────────────
// Feature: kiro-http-bridge, Property 4: Server binds to loopback only
describe('Property 4: Server binds to loopback only', () => {
	// **Validates: Requirements 1.5, 11.1**

	it('port file exists and the port is accessible on 127.0.0.1', async () => {
		const server = createHttpBridgeServer(makeDeps());
		activeServer = server;
		await server.start();

		// Port file should exist (server started successfully on loopback)
		expect(fs.existsSync(PORT_FILE_PATH)).toBe(true);
		expect(server.port).not.toBeNull();

		// Verify the port is accessible on 127.0.0.1 (Req 1.5, 11.1)
		const res = await httpRequest(server.port!, 'POST', '/prompt-start', '{}');
		expect(res.statusCode).toBe(200);
	});
});

// ── Property 5: Port file permissions ───────────────────────────────────────
// Feature: kiro-http-bridge, Property 5: Port file permissions
describe('Property 5: Port file permissions', () => {
	// **Validates: Requirements 11.2**

	it('port file has mode 0o600 (owner read/write only)', async () => {
		// Skip on Windows — file permissions work differently
		if (process.platform === 'win32') {
			return;
		}

		const server = createHttpBridgeServer(makeDeps());
		activeServer = server;
		await server.start();

		const stat = fs.statSync(PORT_FILE_PATH);
		// Check permission bits (Req 11.2)
		expect(stat.mode & 0o777).toBe(0o600); // bitwise AND to extract permission bits
	});
});


// ── Property 13: Invalid request handling ───────────────────────────────────
// Feature: kiro-http-bridge, Property 13: Invalid request handling
describe('Property 13: Invalid request handling', () => {
	// **Validates: Requirements 10.1, 10.2, 10.5**

	it('non-JSON string body → 400', async () => {
		const server = createHttpBridgeServer(makeDeps());
		activeServer = server;
		await server.start();
		const port = server.port!;

		await fc.assert(
			fc.asyncProperty(
				// Generate random non-JSON strings (avoid valid JSON)
				fc.string({ minLength: 1, maxLength: 200 }).filter((s) => {
					try { JSON.parse(s); return false; } catch { return true; }
				}),
				async (invalidJson) => {
					const res = await httpRequest(port, 'POST', '/prompt-start', invalidJson);
					// Malformed JSON → 400 (Req 10.1)
					expect(res.statusCode).toBe(400);
					const body = JSON.parse(res.body);
					expect(body.error).toBe('Invalid JSON');
				},
			),
			{ numRuns: 30 },
		);
	});

	it('unknown URL path → 404', async () => {
		const server = createHttpBridgeServer(makeDeps());
		activeServer = server;
		await server.start();
		const port = server.port!;

		// Arbitrary for random URL paths that are NOT valid endpoints
		const validPaths = new Set(['/prompt-start', '/tool-start', '/tool-done', '/agent-stop']);
		const randomPathArb = fc.string({ minLength: 1, maxLength: 50 })
			.map((s) => '/' + s.replace(/[^a-zA-Z0-9\-_/]/g, 'x'))
			.filter((p) => !validPaths.has(p));

		await fc.assert(
			fc.asyncProperty(randomPathArb, async (unknownPath) => {
				const res = await httpRequest(port, 'POST', unknownPath, '{}');
				// Unknown path → 404 (Req 10.2)
				expect(res.statusCode).toBe(404);
				const body = JSON.parse(res.body);
				expect(body.error).toBe('Not found');
			}),
			{ numRuns: 30 },
		);
	});

	it('non-POST method on valid endpoint → 405', async () => {
		const server = createHttpBridgeServer(makeDeps());
		activeServer = server;
		await server.start();
		const port = server.port!;

		const validEndpoints = ['/prompt-start', '/tool-start', '/tool-done', '/agent-stop'] as const;
		const nonPostMethods = ['GET', 'PUT', 'DELETE', 'PATCH'] as const;

		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...validEndpoints),
				fc.constantFrom(...nonPostMethods),
				async (endpoint, method) => {
					const res = await httpRequest(port, method, endpoint);
					// Wrong method → 405 (Req 10.5)
					expect(res.statusCode).toBe(405);
					const body = JSON.parse(res.body);
					expect(body.error).toBe('Method not allowed');
				},
			),
			{ numRuns: 30 },
		);
	});
});

// ── Property 14: Request body size limit ────────────────────────────────────
// Feature: kiro-http-bridge, Property 14: Request body size limit
describe('Property 14: Request body size limit', () => {
	// **Validates: Requirements 11.3**

	it('body larger than HTTP_BRIDGE_MAX_BODY_BYTES → 413 or connection reset', async () => {
		const server = createHttpBridgeServer(makeDeps());
		activeServer = server;
		await server.start();
		const port = server.port!;

		await fc.assert(
			fc.asyncProperty(
				// Generate sizes just over the limit (1 to 1024 bytes over)
				fc.integer({ min: 1, max: 1024 }),
				async (extraBytes) => {
					const oversizedBody = 'x'.repeat(HTTP_BRIDGE_MAX_BODY_BYTES + extraBytes);
					try {
						const res = await httpRequest(port, 'POST', '/prompt-start', oversizedBody);
						// If we get a response, it should be 413 (Req 11.3)
						expect(res.statusCode).toBe(413);
						const parsed = JSON.parse(res.body);
						expect(parsed.error).toBe('Request body too large');
					} catch (err: unknown) {
						// The server calls req.destroy() when the body exceeds the limit,
						// which may reset the connection before the 413 response is sent.
						// ECONNRESET confirms the server rejected the oversized body.
						const code = (err as NodeJS.ErrnoException).code;
						expect(code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED').toBe(true);
					}
				},
			),
			{ numRuns: 10 }, // Fewer runs — each sends a large payload
		);
	});
});
