import {spawn, execFile, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import type {CommandResult} from './command-result.js';

const OUTPUT_LIMIT = 24000;
const tail = (text: string) =>
	text.length > OUTPUT_LIMIT
		? `[earlier output truncated]\n${text.slice(-OUTPUT_LIMIT)}`
		: text;
type ManagedProcess = {
	id: string;
	command: string;
	cwd: string;
	child: ChildProcess;
	stdout: string;
	stderr: string;
	status: 'running' | 'exited' | 'failed';
	exitCode: number | null;
};

function terminate(child: ChildProcess): void {
	if (!child.pid) return;
	if (process.platform === 'win32') {
		execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
	} else {
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {
			child.kill('SIGTERM');
		}
		const force = setTimeout(() => {
			try {
				process.kill(-child.pid!, 'SIGKILL');
			} catch {}
		}, 300);
		force.unref();
	}
}
function launch(
	command: string,
	cwd: string,
	env?: Record<string, string>,
): ChildProcess {
	if (!command.trim()) throw new Error('Command must not be empty.');
	// Pass the command unchanged: splitting on spaces breaks quoted paths and source text.
	return spawn(command, {
		cwd,
		shell: true,
		detached: process.platform !== 'win32',
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {...process.env, ...env},
	});
}

export class Terminal {
	private readonly processes = new Map<string, ManagedProcess>();
	runCommand(
		command: string,
		cwd: string,
		contextMessage?: string,
		timeoutMs = 120000,
	): Promise<CommandResult> {
		if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
			return Promise.reject(new Error('timeoutMs must be 1–600000.'));
		return new Promise(resolve => {
			let stdout = contextMessage ? `${contextMessage}\n` : '',
				stderr = '',
				timedOut = false,
				settled = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const finish = (exitCode: number) => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				resolve({
					success: exitCode === 0 && !timedOut,
					stdout: tail(stdout).trim(),
					stderr: tail(stderr).trim(),
					exitCode,
					...(timedOut ? {timedOut: true} : {}),
				});
			};
			try {
				const child = launch(command, cwd);
				child.stdout?.on('data', (data: Buffer) => {
					stdout = tail(stdout + data.toString());
				});
				child.stderr?.on('data', (data: Buffer) => {
					stderr = tail(stderr + data.toString());
				});
				child.once('error', error => {
					stderr += `\n${error.message}`;
					finish(-1);
				});
				child.once('close', code => finish(code ?? -1));
				timeout = setTimeout(() => {
					timedOut = true;
					stderr +=
						'\nCommand timed out. Use start_process for servers, then http_request and stop_process.';
					terminate(child);
					finish(-1);
				}, timeoutMs);
			} catch (error) {
				stderr += `\n${error instanceof Error ? error.message : String(error)}`;
				finish(-1);
			}
		});
	}
	async startProcess(
		command: string,
		cwd: string,
		env?: Record<string, string>,
	) {
		const child = launch(command, cwd, env);
		const entry: ManagedProcess = {
			id: randomUUID(),
			command,
			cwd,
			child,
			stdout: '',
			stderr: '',
			status: 'running',
			exitCode: null,
		};
		this.processes.set(entry.id, entry);
		child.stdout?.on('data', (data: Buffer) => {
			entry.stdout = tail(entry.stdout + data.toString());
		});
		child.stderr?.on('data', (data: Buffer) => {
			entry.stderr = tail(entry.stderr + data.toString());
		});
		child.on('error', error => {
			entry.stderr = tail(entry.stderr + `\n${error.message}`);
			entry.status = 'failed';
			entry.exitCode = -1;
		});
		child.once('close', code => {
			entry.exitCode = code ?? -1;
			entry.status = code === 0 ? 'exited' : 'failed';
		});
		await new Promise<void>(resolve => {
			child.once('spawn', resolve);
			child.once('error', () => resolve());
		});
		return this.getProcess(entry.id);
	}
	getProcess(id: string) {
		const entry = this.processes.get(id);
		if (!entry) throw new Error('Unknown managed process ID.');
		return {
			processId: entry.id,
			pid: entry.child.pid ?? null,
			command: entry.command,
			cwd: entry.cwd,
			status: entry.status,
			exitCode: entry.exitCode,
			stdout: entry.stdout,
			stderr: entry.stderr,
		};
	}
	async stopProcess(id: string) {
		const entry = this.processes.get(id);
		if (!entry) throw new Error('Unknown managed process ID.');
		if (entry.status === 'running') {
			await new Promise<void>(resolve => {
				const timeout = setTimeout(resolve, 3000);
				entry.child.once('close', () => {
					clearTimeout(timeout);
					resolve();
				});
				terminate(entry.child);
			});
		}
		return this.getProcess(id);
	}
	async stopAll(): Promise<void> {
		await Promise.all(
			[...this.processes.keys()].map(async id => this.stopProcess(id)),
		);
	}
}
