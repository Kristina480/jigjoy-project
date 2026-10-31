import test from 'ava';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	createHuman,
	FunctionCallItem,
	ModelMessageItem,
	UserMessageItem,
	type InferenceRunner,
	type InferenceOutput,
} from '@mozaik-ai/core';
import {
	EnvironmentState,
	initializeRuntime,
	join,
	sendMessage,
} from '../source/runtime.js';
import {createRuntimeObserver} from '../source/runtime-observer.js';
import {createTerminalAgent} from '../source/terminal/agent.js';
import {createRoleAgent} from '../source/agents/role-agent.js';
import {
	configureAgentProvisioning,
	resetTaskRouter,
} from '../source/agents/task-router.js';

let coordinatorTurns = 0,
	workerTurns = 0,
	workerReceived = '';
let completed!: () => void;
const finished = new Promise<void>(resolve => {
	completed = resolve;
});
const result = (items: InferenceOutput['items']): InferenceOutput => ({
	items,
	tokenUsage: undefined,
	rowResponse: null,
});
const call = (id: string, name: string, args: unknown) =>
	FunctionCallItem.rehydrate({callId: id, name, args: JSON.stringify(args)});
const runner: InferenceRunner = {
	async *stream() {
		throw new Error('Streaming not used by fixture.');
	},
	async run(input) {
		if (input.tools?.some(tool => tool.name === 'delegate_team_plan')) {
			switch (coordinatorTurns++) {
				case 0:
					return result([call('workspace', 'get_workspace_info', {})]);
				case 1:
					return result([
						call('requirements', 'load_project_requirements', {
							path: 'examples/box-office/specification.md',
						}),
					]);
				case 2:
					return result([
						call('plan', 'delegate_team_plan', {
							tasks: [
								{
									key: 'receipt',
									role: 'backend',
									task: 'Write a requirements receipt only, not an API implementation.',
									acceptanceCriteria: ['The original specification is intact.'],
									dependsOn: [],
								},
							],
							completedDependencies: [],
						}),
					]);
				default:
					return result([
						ModelMessageItem.rehydrate({
							text: 'Requirements fixture completed.',
						}),
					]);
			}
		}
		const prompt = input.context
			.getItems()
			.find(item => item instanceof UserMessageItem)!.content.text;
		if (workerTurns++ === 0) {
			workerReceived = prompt;
			return result([call('worker-workspace', 'get_workspace_info', {})]);
		}
		if (workerTurns === 2) {
			const marker =
				'Requirements file examples/box-office/specification.md:\n\n';
			const start = prompt.indexOf(marker);
			if (start < 0) throw new Error('Worker lost the original requirements.');
			return result([
				call('write', 'write_file', {
					path: 'probe/requirements-received.txt',
					content: prompt.slice(start + marker.length).trimEnd(),
				}),
			]);
		}
		return result([
			call('submit', 'submit_task_result', {
				taskId: /Task ID: ([^\n]+)/.exec(prompt)![1],
				status: 'done',
				summary: 'Requirements receipt written; no API generated.',
				filesChanged: ['probe/requirements-received.txt'],
				checks: ['Fixture requirement transfer checked.'],
				blockers: [],
			}),
		]);
	},
};
initializeRuntime({
	state: new EnvironmentState(),
	inferenceRunnerConfig: {runner},
});

test.serial(
	'JigJoy loads the complete Box Office input and its real worker uses the native file tool',
	async t => {
		t.timeout(10000);
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), 'JigJoy factory input '),
		);
		const oldRoot = process.env['JIGJOY_WORKSPACE'];
		process.env['JIGJOY_WORKSPACE'] = root;
		t.teardown(async () => {
			if (oldRoot === undefined) delete process.env['JIGJOY_WORKSPACE'];
			else process.env['JIGJOY_WORKSPACE'] = oldRoot;
			resetTaskRouter();
			await fs.rm(root, {recursive: true, force: true});
		});
		const specification = await fs.readFile(
			'examples/box-office/specification.md',
			'utf8',
		);
		await fs.mkdir(path.join(root, 'examples/box-office'), {recursive: true});
		await fs.writeFile(
			path.join(root, 'examples/box-office/specification.md'),
			specification,
		);
		resetTaskRouter();
		join(
			createRuntimeObserver(event => {
				if (
					event.type === 'model.answer' &&
					(event.payload as {answer: {content: {text: string}}}).answer.content
						.text === 'Requirements fixture completed.'
				)
					completed();
			}),
		);
		configureAgentProvisioning((role, name) =>
			join(createRoleAgent(role, name)),
		);
		join(createTerminalAgent());
		const user = createHuman({name: 'User', capabilities: [], handlers: []});
		join(user);
		sendMessage(
			'Load examples/box-office/specification.md and write only a requirements receipt for this offline fixture.',
			user.getId(),
		);
		await finished;
		t.true(workerReceived.includes(specification.trimEnd()));
		for (const section of [
			'## 1. Accounts',
			'## 2. Events',
			'## 3. Orders',
			'## 4. Discount codes',
			'## 5. Waitlist',
			'## 6. Report',
			'HOLD_SECONDS',
			'strictly in order',
		])
			t.true(workerReceived.includes(section));
		t.is(
			await fs.readFile(
				path.join(root, 'probe/requirements-received.txt'),
				'utf8',
			),
			specification.trimEnd(),
		);
		await t.throwsAsync(fs.stat(path.join(root, 'hidden/box-office')));
	},
);
