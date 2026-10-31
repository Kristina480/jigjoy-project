import test from 'ava';
import {
	FunctionCallItem,
	FunctionCallOutputItem,
	ModelContext,
	ModelMessageItem,
	type InferenceOutput,
	type InferenceRunner,
	type SemanticEvent,
	type Tool,
} from '@mozaik-ai/core';
import {createConcurrentRunLoop} from './concurrent-loop.js';

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(done => {
		resolve = done;
	});
	return {promise, resolve};
}
const answer = (): InferenceOutput => ({
	items: [ModelMessageItem.rehydrate({text: 'Done.'})],
	tokenUsage: undefined,
	rowResponse: null,
});
const call = (id: string, name: string) =>
	FunctionCallItem.rehydrate({callId: id, name, args: '{}'});
const stream: InferenceRunner['stream'] = async function* () {
	throw new Error('Streaming is not used by this test.');
};
function fixture(runner: InferenceRunner) {
	const events: SemanticEvent[] = [];
	const loop = createConcurrentRunLoop(() => ({
		publish(event) {
			events.push(event);
		},
		getInferenceRunner: () => runner,
		getFunctionCallRunner: () => ({
			run: async (item, tool) =>
				FunctionCallOutputItem.create(
					item.callId,
					JSON.stringify(await tool.invoke(JSON.parse(item.args))),
				),
		}),
	}));
	return {loop, events};
}
function tool(name: string, invoke: Tool['invoke']): Tool {
	return {
		name,
		type: 'function',
		description: name,
		parameters: {type: 'object', properties: {}},
		strict: true,
		invoke,
	};
}

test('every tool call in one model response starts before any output is released', async t => {
	t.timeout(10000);
	const bothStarted = deferred();
	const release = deferred();
	let starts = 0;
	let turns = 0;
	const context = ModelContext.create();
	const {loop} = fixture({
		stream,
		async run(input) {
			if (turns++ === 0)
				return {
					items: [call('a', 'first'), call('b', 'second')],
					tokenUsage: undefined,
					rowResponse: null,
				};
			t.deepEqual(
				input.context
					.getItems()
					.filter(item => item instanceof FunctionCallOutputItem)
					.map(item => item.callId),
				['a', 'b'],
			);
			return answer();
		},
	});
	const invoke = async () => {
		if (++starts === 2) bothStarted.resolve();
		await release.promise;
		return 'ok';
	};
	const run = loop('coordinator', 'Run both.', {
		model: 'test',
		context,
		tools: [tool('first', invoke), tool('second', invoke)],
	});
	await bothStarted.promise;
	t.is(starts, 2);
	release.resolve();
	await run;
	t.is(turns, 2);
});

test('different agents infer concurrently while turns for one agent remain serialized', async t => {
	t.timeout(10000);
	const bothStarted = deferred();
	const release = deferred();
	let starts = 0;
	const {loop} = fixture({
		stream,
		async run() {
			if (++starts === 2) bothStarted.resolve();
			await release.promise;
			return answer();
		},
	});
	const input = () => ({model: 'test', context: ModelContext.create()});
	const first = loop('frontend', 'Build UI.', input());
	const second = loop('backend', 'Build API.', input());
	await bothStarted.promise;
	t.is(starts, 2);
	const queued = loop('frontend', 'Next UI task.', input());
	await Promise.resolve();
	t.is(starts, 2);
	release.resolve();
	await Promise.all([first, second, queued]);
	t.is(starts, 3);
});

test('a rejected inference emits a scoped failure and does not cancel another agent', async t => {
	const events: SemanticEvent[] = [];
	const {loop, events: recorded} = fixture({
		stream,
		async run(input) {
			if (input.model === 'fail') throw new Error('Provider unavailable');
			return answer();
		},
	});
	const results = await Promise.allSettled([
		loop('failed-agent', 'Work', {
			model: 'fail',
			context: ModelContext.create(),
		}),
		loop('healthy-agent', 'Work', {
			model: 'ok',
			context: ModelContext.create(),
		}),
	]);
	events.push(...recorded);
	t.is(results[0]!.status, 'rejected');
	t.is(results[1]!.status, 'fulfilled');
	t.true(
		events.some(
			event =>
				event.type === 'agent.run.failed' &&
				event.producerId === 'failed-agent',
		),
	);
	t.true(
		events.some(
			event =>
				event.type === 'agent.run.completed' &&
				event.producerId === 'healthy-agent',
		),
	);
});

test('result submission waits for every other tool in its model response', async t => {
	const completed: string[] = [];
	const {loop} = fixture({
		stream,
		async run() {
			return {
				items: [call('submit', 'submit_task_result'), call('work', 'work')],
				tokenUsage: undefined,
				rowResponse: null,
			};
		},
	});
	await loop('worker', 'Work', {
		model: 'test',
		context: ModelContext.create(),
		tools: [
			tool('work', async () => {
				completed.push('work');
				return 'ok';
			}),
			tool('submit_task_result', async () => {
				completed.push('submit');
				return {accepted: true};
			}),
		],
	});
	t.deepEqual(completed, ['work', 'submit']);
});

test('an isolated coordinator handoff can unblock a waiting main turn without copying pending calls', async t => {
	t.timeout(10000);
	const waiting = deferred();
	const help = deferred();
	const context = ModelContext.create();
	let handoffTurns = 0;
	const {loop} = fixture({
		stream,
		async run(input) {
			if (input.context !== context) {
				t.false(
					input.context.getItems().some(item => item.type === 'function_call'),
				);
				handoffTurns++;
				help.resolve();
				return answer();
			}
			if (
				!input.context
					.getItems()
					.some(item => item.type === 'function_call_output')
			) {
				return {
					items: [call('main', 'delegate')],
					tokenUsage: undefined,
					rowResponse: null,
				};
			}
			return answer();
		},
	});
	const input = {
		model: 'test',
		context,
		tools: [
			tool('delegate', async () => {
				waiting.resolve();
				await help.promise;
				return 'worker completed';
			}),
		],
	};
	const main = loop('coordinator', 'Main task', input);
	await waiting.promise;
	await loop('coordinator', 'Help request', input, {
		concurrent: true,
		isolated: true,
	});
	await main;
	t.is(handoffTurns, 1);
	t.false(
		context
			.getItems()
			.some(
				item =>
					'content' in item && JSON.stringify(item).includes('Help request'),
			),
	);
});

test('a rejected result submission is returned to the model so it can correct the task ID', async t => {
	let turns = 0,
		submissions = 0;
	const {loop} = fixture({
		stream,
		async run(input) {
			turns++;
			if (turns === 2)
				t.true(
					input.context
						.getItems()
						.some(
							item =>
								item instanceof FunctionCallOutputItem &&
								item.output.text.includes('false'),
						),
				);
			return {
				items: [call(`submit-${turns}`, 'submit_task_result')],
				tokenUsage: undefined,
				rowResponse: null,
			};
		},
	});
	await loop('worker', 'Use the assigned ID.', {
		model: 'test',
		context: ModelContext.create(),
		tools: [
			tool('submit_task_result', async () => ({accepted: ++submissions > 1})),
		],
	});
	t.is(turns, 2);
	t.is(submissions, 2);
});
