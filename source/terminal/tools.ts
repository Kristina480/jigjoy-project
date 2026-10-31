import type {Tool} from '@mozaik-ai/core';
import {Terminal} from './terminal.js';
import {createWorkspaceTools, workspacePath} from './workspace-tools.js';

const terminal = new Terminal();
export const stopManagedProcesses = async () => terminal.stopAll();
export const terminalTools: Tool[] = [
	...createWorkspaceTools(),
	{
		name: 'run_command',
		description:
			'Run a finite command in the actual workspace shell. Preserve quoting. This tool times out; use start_process for a long-running server. Inspect success and stderr before reporting checks.',
		parameters: {
			type: 'object',
			properties: {
				command: {type: 'string'},
				cwd: {type: 'string'},
				timeoutMs: {type: ['integer', 'null'], minimum: 1, maximum: 600000},
			},
			required: ['command', 'cwd', 'timeoutMs'],
		},
		strict: true,
		type: 'function',
		invoke: async (args: {
			command: string;
			cwd: string;
			timeoutMs?: number | null;
		}) => {
			if (
				/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:start|dev|serve)(?:\s|$)/.test(
					args.command,
				)
			) {
				return {
					success: false,
					stdout: '',
					stderr:
						'Use start_process for this long-running server command, then http_request and stop_process.',
					exitCode: -1,
				};
			}
			return terminal.runCommand(
				args.command,
				workspacePath(args.cwd),
				undefined,
				args.timeoutMs ?? 120000,
			);
		},
	},
	{
		name: 'start_process',
		description:
			'Start a long-running server without blocking the agent. Returns a processId; this does not prove the server is ready. Inspect output and use http_request, then stop_process after verification. Choose a port different from JigJoy.',
		parameters: {
			type: 'object',
			properties: {
				command: {type: 'string'},
				cwd: {type: 'string'},
				env: {type: ['object', 'null'], additionalProperties: {type: 'string'}},
			},
			required: ['command', 'cwd', 'env'],
		},
		strict: true,
		type: 'function',
		invoke: async (args: {
			command: string;
			cwd: string;
			env?: Record<string, string> | null;
		}) =>
			terminal.startProcess(
				args.command,
				workspacePath(args.cwd),
				args.env ?? undefined,
			),
	},
	{
		name: 'get_process_output',
		description:
			'Inspect a managed process status, exit code and recent stdout/stderr without waiting for it to exit.',
		parameters: {
			type: 'object',
			properties: {processId: {type: 'string'}},
			required: ['processId'],
		},
		strict: true,
		type: 'function',
		invoke: async (args: {processId: string}) =>
			terminal.getProcess(args.processId),
	},
	{
		name: 'stop_process',
		description:
			'Stop a managed process and its process tree when finished with a server smoke check.',
		parameters: {
			type: 'object',
			properties: {processId: {type: 'string'}},
			required: ['processId'],
		},
		strict: true,
		type: 'function',
		invoke: async (args: {processId: string}) =>
			terminal.stopProcess(args.processId),
	},
	{
		name: 'http_request',
		description:
			'Make a JSON/text HTTP request to a local test server (localhost, 127.0.0.1 or ::1). Use to verify generated endpoints without platform-specific curl commands. Returns status and response body; non-2xx is not a successful check.',
		parameters: {
			type: 'object',
			properties: {
				url: {type: 'string'},
				method: {
					type: 'string',
					enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
				},
				headers: {
					type: ['object', 'null'],
					additionalProperties: {type: 'string'},
				},
				body: {type: ['string', 'null']},
			},
			required: ['url', 'method', 'headers', 'body'],
		},
		strict: true,
		type: 'function',
		invoke: async (args: {
			url: string;
			method: string;
			headers?: Record<string, string> | null;
			body?: string | null;
		}) => {
			const url = new URL(args.url);
			if (
				!['http:', 'https:'].includes(url.protocol) ||
				!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
			)
				throw new Error('http_request is for loopback test servers only.');
			const response = await fetch(url, {
				method: args.method,
				headers: {
					...(args.body !== null && args.body !== undefined
						? {'Content-Type': 'application/json'}
						: {}),
					...args.headers,
				},
				...(args.body !== null && args.body !== undefined
					? {body: args.body}
					: {}),
				signal: AbortSignal.timeout(5000),
				redirect: 'error',
			});
			const text = await response.text();
			let body: unknown = text.slice(0, 24000);
			if (text.length <= 24000) {
				try {
					body = JSON.parse(text) as unknown;
				} catch {}
			}
			return {status: response.status, body, truncated: text.length > 24000};
		},
	},
];
