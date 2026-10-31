import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Tool} from '@mozaik-ai/core';

export function getWorkspaceRoot(): string {
	return path.resolve(process.env['JIGJOY_WORKSPACE'] ?? process.cwd());
}
export function workspacePath(input = '.', root = getWorkspaceRoot()): string {
	const target = path.resolve(root, input);
	const relative = path.relative(root, target);
	if (
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		throw new Error(
			'Path is outside JIGJOY_WORKSPACE. Use get_workspace_info for the configured root.',
		);
	return target;
}
export function createWorkspaceTools(
	root: () => string = getWorkspaceRoot,
): Tool[] {
	return [
		{
			name: 'get_workspace_info',
			description:
				'Get the actual workspace root, OS, shell and Node version. Call this before planning paths or commands. Never guess a Windows or Unix path.',
			type: 'function',
			strict: true,
			parameters: {type: 'object', properties: {}, required: []},
			invoke: async () => ({
				workspaceRoot: root(),
				platform: process.platform,
				shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
				nodeVersion: process.version,
				nodeExecutable: process.execPath,
			}),
		},
		{
			name: 'list_files',
			description:
				'List paths in a workspace directory without OS-specific shell commands. Recursive listing skips .git, node_modules and dist.',
			type: 'function',
			strict: true,
			parameters: {
				type: 'object',
				properties: {path: {type: 'string'}, recursive: {type: 'boolean'}},
				required: ['path', 'recursive'],
			},
			invoke: async (args: {path: string; recursive: boolean}) => {
				const base = workspacePath(args.path, root());
				const files: Array<{
					path: string;
					type: 'file' | 'directory' | 'symlink';
				}> = [];
				async function visit(directory: string): Promise<void> {
					for (const entry of (
						await fs.readdir(directory, {withFileTypes: true})
					).sort((a, b) => a.name.localeCompare(b.name))) {
						if (files.length >= 1000) return;
						const target = path.join(directory, entry.name);
						files.push({
							path: path.relative(root(), target),
							type: entry.isSymbolicLink()
								? 'symlink'
								: entry.isDirectory()
								? 'directory'
								: 'file',
						});
						if (
							args.recursive &&
							entry.isDirectory() &&
							!['.git', 'node_modules', 'dist'].includes(entry.name)
						)
							await visit(target);
					}
				}
				await visit(base);
				return {files, truncated: files.length >= 1000};
			},
		},
		{
			name: 'read_file',
			description:
				'Read UTF-8 source text using a workspace-relative path. Lines are 1-based. Follow nextLine when hasMore is true. Do not inspect credential files.',
			type: 'function',
			strict: true,
			parameters: {
				type: 'object',
				properties: {
					path: {type: 'string'},
					startLine: {type: 'integer', minimum: 1},
					maxLines: {type: 'integer', minimum: 1, maximum: 500},
				},
				required: ['path', 'startLine', 'maxLines'],
			},
			invoke: async (args: {
				path: string;
				startLine: number;
				maxLines: number;
			}) => {
				if (
					!Number.isInteger(args.startLine) ||
					args.startLine < 1 ||
					!Number.isInteger(args.maxLines) ||
					args.maxLines < 1 ||
					args.maxLines > 500
				)
					throw new Error('Invalid line range.');
				const target = workspacePath(args.path, root());
				const lines = (await fs.readFile(target, 'utf8')).split('\n');
				const end = Math.min(lines.length, args.startLine - 1 + args.maxLines);
				return {
					path: path.relative(root(), target),
					content: lines.slice(args.startLine - 1, end).join('\n'),
					hasMore: end < lines.length,
					nextLine: end < lines.length ? end + 1 : null,
				};
			},
		},
		{
			name: 'write_file',
			description:
				'Create or replace a UTF-8 file atomically, creating parent directories. Use this for source code and JSON instead of echo, heredocs or shell escaping. Respect assigned file ownership.',
			type: 'function',
			strict: true,
			parameters: {
				type: 'object',
				properties: {path: {type: 'string'}, content: {type: 'string'}},
				required: ['path', 'content'],
			},
			invoke: async (args: {path: string; content: string}) => {
				if (typeof args.path !== 'string' || typeof args.content !== 'string')
					throw new Error('path and content must be strings.');
				const target = workspacePath(args.path, root());
				await fs.mkdir(path.dirname(target), {recursive: true});
				const temporary = `${target}.${randomUUID()}.tmp`;
				try {
					await fs.writeFile(temporary, args.content, 'utf8');
					await fs.rename(temporary, target);
				} finally {
					await fs.rm(temporary, {force: true});
				}
				return {
					path: path.relative(root(), target),
					bytesWritten: Buffer.byteLength(args.content),
				};
			},
		},
	];
}
