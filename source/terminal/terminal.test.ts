import test from 'ava';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Terminal} from './terminal.js';
import {createWorkspaceTools, workspacePath} from './workspace-tools.js';
import {terminalTools} from './tools.js';

async function folder() {
	return fs.mkdtemp(path.join(os.tmpdir(), 'JigJoy Željko work '));
}
const command = (file: string) => `"${process.execPath}" "${file}"`;

test('native file tools preserve quotes, dollars, newlines and Unicode in a path containing spaces', async t => {
	const root = await folder();
	t.teardown(async () => fs.rm(root, {recursive: true, force: true}));
	const tools = createWorkspaceTools(() => root);
	const find = (name: string) => tools.find(tool => tool.name === name)!;
	const content =
		'const tekst = `Željko $HOME $(nothing) "quote"`;\nDrugi red\nTreći red';
	await find('write_file').invoke({
		path: 'generated/ime sa razmakom.ts',
		content,
	});
	t.is(
		await fs.readFile(path.join(root, 'generated/ime sa razmakom.ts'), 'utf8'),
		content,
	);
	const first = await find('read_file').invoke({
		path: 'generated/ime sa razmakom.ts',
		startLine: 1,
		maxLines: 2,
	});
	t.is(first.content, content.split('\n').slice(0, 2).join('\n'));
	t.true(first.hasMore);
	t.is(first.nextLine, 3);
	const listing = await find('list_files').invoke({path: '.', recursive: true});
	t.true(
		listing.files.some((entry: {path: string}) =>
			entry.path.endsWith('ime sa razmakom.ts'),
		),
	);
	t.is((await find('get_workspace_info').invoke({})).workspaceRoot, root);
	t.throws(() => workspacePath('../outside', root));
});

test('finite commands preserve a quoted executable and script path', async t => {
	const root = await folder();
	t.teardown(async () => fs.rm(root, {recursive: true, force: true}));
	const file = path.join(root, 'quoted script.cjs');
	await fs.writeFile(file, 'console.log("Hello Željko from a quoted path");');
	const result = await new Terminal().runCommand(command(file), root);
	t.true(result.success);
	t.is(result.exitCode, 0);
	t.true(result.stdout.includes('Hello Željko'));
});

test('a command that never exits times out instead of blocking an agent forever', async t => {
	t.timeout(5000);
	const root = await folder();
	t.teardown(async () => fs.rm(root, {recursive: true, force: true}));
	const file = path.join(root, 'wait.cjs');
	await fs.writeFile(file, 'setInterval(() => {}, 1000);');
	const result = await new Terminal().runCommand(
		command(file),
		root,
		undefined,
		200,
	);
	t.false(result.success);
	t.true(result.timedOut);
	t.true(result.stderr.includes('start_process'));
});

test('an invalid cwd returns an actionable command failure', async t => {
	const result = await new Terminal().runCommand(
		'node --version',
		path.join(os.tmpdir(), 'jigjoy-nonexistent-cwd-989909'),
	);
	t.false(result.success);
	t.is(result.exitCode, -1);
	t.true(result.stderr.length > 0);
});

test('managed local servers start nonblocking, expose output and can be HTTP-tested and stopped', async t => {
	t.timeout(10000);
	const root = await folder(),
		terminal = new Terminal();
	t.teardown(async () => {
		await terminal.stopAll();
		await fs.rm(root, {recursive: true, force: true});
	});
	const file = path.join(root, 'local server.cjs');
	await fs.writeFile(
		file,
		`const http = require('node:http'); const server = http.createServer((req,res) => {res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,tag:process.env.TEST_TAG}));}); server.listen(0,'127.0.0.1',() => console.log('READY '+server.address().port));`,
	);
	const started = await terminal.startProcess(command(file), root, {
		TEST_TAG: 'managed-test',
	});
	t.is(started.status, 'running');
	let port = '';
	for (let attempt = 0; attempt < 200; attempt++) {
		port =
			/READY (\d+)/.exec(terminal.getProcess(started.processId).stdout)?.[1] ??
			'';
		if (port) break;
		await delay(10);
	}
	t.true(Boolean(port));
	const response = await terminalTools
		.find(tool => tool.name === 'http_request')!
		.invoke({
			url: `http://127.0.0.1:${port}/`,
			method: 'GET',
			headers: null,
			body: null,
		});
	t.is(response.status, 200);
	t.deepEqual(response.body, {ok: true, tag: 'managed-test'});
	const stopped = await terminal.stopProcess(started.processId);
	t.not(stopped.status, 'running');
});

test('local HTTP verification rejects an external URL before making a request', async t => {
	await t.throwsAsync(
		terminalTools
			.find(tool => tool.name === 'http_request')!
			.invoke({
				url: 'https://example.com',
				method: 'GET',
				headers: null,
				body: null,
			}),
		{message: 'http_request is for loopback test servers only.'},
	);
});

test('npm start is redirected to managed processes before a blocking shell command is launched', async t => {
	const response = await terminalTools
		.find(tool => tool.name === 'run_command')!
		.invoke({command: 'npm start', cwd: '.', timeoutMs: null});
	t.false(response.success);
	t.is(response.exitCode, -1);
	t.true(response.stderr.includes('start_process'));
});
