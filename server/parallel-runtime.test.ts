import test from 'ava';
import {
	createHuman,
	FunctionCallItem,
	ModelMessageItem,
	UserMessageItem,
	type InferenceOutput,
	type InferenceRunner,
} from '@mozaik-ai/core';
import {
	EnvironmentState,
	initializeRuntime,
	join,
	sendMessage,
} from '../source/runtime.js';
import {createRuntimeObserver} from '../source/runtime-observer.js';
import {createRoleAgent} from '../source/agents/role-agent.js';
import {createTerminalAgent} from '../source/terminal/agent.js';
import {
	configureAgentProvisioning,
	getAgentAvailability,
	resetTaskRouter,
} from '../source/agents/task-router.js';
import {createTranslator} from './translate.js';
import {
	getTeamActivity,
	initialState,
	reduce,
	type State,
} from '../web/src/state/store.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => {
		resolve = done;
	});
	return {promise, resolve};
}
const roots = ['frontend', 'backend', 'marketing'];
const gates = new Map(roots.map(role => [role, deferred()]));
const started = new Set<string>();
const allStarted = deferred();
const frontendFinished = deferred();
const finished = deferred();
let coordinatorTurns = 0;
let receivedDiscoveryOutputs = 0;
const output = (items: InferenceOutput['items']): InferenceOutput => ({
	items,
	tokenUsage: undefined,
	rowResponse: null,
});
const functionCall = (id: string, name: string, args: unknown) =>
	FunctionCallItem.rehydrate({callId: id, name, args: JSON.stringify(args)});
const runner: InferenceRunner = {
	async *stream() {
		throw new Error('Streaming not used.');
	},
	async run(input) {
		if (input.tools?.some(tool => tool.name === 'delegate_team_plan')) {
			if (coordinatorTurns++ === 0)
				return output([
					functionCall('roles', 'list_agent_roles', {}),
					functionCall('recipes', 'get_team_guidance', {}),
				]);
			if (coordinatorTurns === 2) {
				receivedDiscoveryOutputs = input.context
					.getItems()
					.filter(item => item.type === 'function_call_output').length;
				return output([
					functionCall('team', 'delegate_team_plan', {
						tasks: [
							...roots.map(role => ({
								key: role,
								role,
								task: `WORK ${role}`,
								acceptanceCriteria: ['Return a result.'],
								dependsOn: [],
							})),
							{
								key: 'verify',
								role: 'tester',
								task: 'WORK tester',
								acceptanceCriteria: ['Verify all three results.'],
								dependsOn: roots,
							},
						],
						completedDependencies: [],
					}),
				]);
			}
			return output([
				ModelMessageItem.rehydrate({
					text: 'All three workstreams and verification completed.',
				}),
			]);
		}
		const prompt = input.context
			.getItems()
			.filter(item => item instanceof UserMessageItem)
			.at(-1)!.content.text;
		const role = /Task: WORK (\w+)/.exec(prompt)![1]!;
		const taskId = /Task ID: ([^\n]+)/.exec(prompt)![1]!;
		started.add(role);
		if (roots.every(role => started.has(role))) allStarted.resolve();
		await gates.get(role)?.promise;
		return output([
			functionCall(`result-${taskId}`, 'submit_task_result', {
				taskId,
				status: 'done',
				summary: `${role} completed`,
				filesChanged: [],
				checks: ['Synthetic inference runner'],
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
	'real coordinator and role-agent loops overlap three workers and preserve live dashboard state',
	async t => {
		t.timeout(10000);
		t.teardown(() => {
			for (const gate of gates.values()) gate.resolve();
			resetTaskRouter();
		});
		resetTaskRouter();
		let state: State = initialState;
		let peak = 0;
		const translate = createTranslator(event => {
			state = reduce(state, event);
			peak = Math.max(peak, getTeamActivity(state.agents).working);
		});
		join(
			createRuntimeObserver(event => {
				translate(event);
				if (
					event.type === 'agent.task.result' &&
					(event.payload as {result: {summary: string}}).result.summary ===
						'frontend completed'
				)
					frontendFinished.resolve();
				if (
					event.type === 'model.answer' &&
					(event.payload as {answer: {content: {text: string}}}).answer.content
						.text === 'All three workstreams and verification completed.'
				)
					finished.resolve();
			}),
		);
		configureAgentProvisioning((role, name) =>
			join(createRoleAgent(role, name)),
		);
		join(createTerminalAgent());
		const user = createHuman({name: 'User', capabilities: [], handlers: []});
		join(user);
		sendMessage(
			'Run independent UI, server and marketing work, then verify.',
			user.getId(),
		);
		await allStarted.promise;
		t.is(receivedDiscoveryOutputs, 2);
		t.is(
			getAgentAvailability().filter(agent => agent.status === 'busy').length,
			3,
		);
		t.is(getTeamActivity(state.agents).working, 3);
		t.false(started.has('tester'));
		gates.get('frontend')!.resolve();
		await frontendFinished.promise;
		t.is(getTeamActivity(state.agents).working, 2);
		t.false(started.has('tester'));
		gates.get('backend')!.resolve();
		gates.get('marketing')!.resolve();
		await finished.promise;
		t.true(peak >= 3);
		t.true(started.has('tester'));
		t.is(getTeamActivity(state.agents).working, 0);
		t.true(
			Object.values(state.agents)
				.flatMap(agent => agent.tasks)
				.every(task => task.status === 'done'),
		);
	},
);
