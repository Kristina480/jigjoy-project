import test from 'ava';
import {createHuman} from '@mozaik-ai/core';
import {EnvironmentState, initializeRuntime, join} from '../runtime.js';
import {createRuntimeObserver} from '../runtime-observer.js';

import {
	createSubmitTaskResultTool,
	configureAgentProvisioning,
	createDelegationTools,
	ensureFreeAgent,
	setCoordinatorId,
	getAgentAvailability,
	getFreeAgentCount,
	getUnresolvedDependencies,
	parseHelpRequestEnvelope,
	parseTaskEnvelope,
	registerAgent,
	resetTaskRouter,
} from './task-router.js';

test('parseTaskEnvelope accepts a task targeted to one registered role agent', t => {
	const task = {
		kind: 'agent.task',
		taskId: 'task-1',
		role: 'backend',
		targetAgentId: 'backend-2',
		task: 'Implement the data endpoint.',
		acceptanceCriteria: ['The endpoint returns the expected data.'],
		dependencies: ['schema-ready'],
		completedDependencies: ['schema-ready'],
	};

	t.deepEqual(parseTaskEnvelope(JSON.stringify(task)), task);
});

test('parseTaskEnvelope rejects a task without a target agent ID', t => {
	const task = {
		kind: 'agent.task',
		taskId: 'task-1',
		role: 'backend',
		task: 'Implement the data endpoint.',
		acceptanceCriteria: [],
		dependencies: [],
		completedDependencies: [],
	};

	t.is(parseTaskEnvelope(JSON.stringify(task)), undefined);
});

test('parseHelpRequestEnvelope accepts a Backend handoff request', t => {
	const request = {
		kind: 'agent.help.request',
		requestId: 'help-1',
		taskId: 'task-1',
		role: 'backend',
		requesterAgentId: 'backend-1',
		remainingWork: 'Add the response validation.',
		dependencies: ['schema-ready'],
		completedDependencies: ['schema-ready'],
	};

	t.deepEqual(parseHelpRequestEnvelope(JSON.stringify(request)), request);
});

test('parseHelpRequestEnvelope rejects requests from a non-Backend role', t => {
	const request = {
		kind: 'agent.help.request',
		requestId: 'help-1',
		taskId: 'task-1',
		role: 'frontend',
		requesterAgentId: 'frontend-1',
		remainingWork: 'Add the response validation.',
		dependencies: [],
		completedDependencies: [],
	};

	t.is(parseHelpRequestEnvelope(JSON.stringify(request)), undefined);
});

test('getUnresolvedDependencies returns only prerequisites not marked complete', t => {
	t.deepEqual(
		getUnresolvedDependencies(
			['schema-ready', 'data-contract'],
			['schema-ready'],
		),
		['data-contract'],
	);
});

test.serial('agent availability lists every free Backend instance', t => {
	resetTaskRouter();
	registerAgent('backend', 'backend-1');
	registerAgent('backend', 'backend-2');
	registerAgent('frontend', 'frontend-1');
	registerAgent('frontend', 'frontend-2');
	registerAgent('integration', 'integration-1');

	t.is(getFreeAgentCount('backend'), 2);
	t.is(getFreeAgentCount('frontend'), 2);
	t.deepEqual(
		getAgentAvailability().map(({role, status}) => ({role, status})),
		[
			{role: 'backend', status: 'free'},
			{role: 'backend', status: 'free'},
			{role: 'frontend', status: 'free'},
			{role: 'frontend', status: 'free'},
			{role: 'integration', status: 'free'},
		],
	);

	resetTaskRouter();
});
test.serial(
	'provisioning creates only requested roles and reuses a free instance',
	t => {
		resetTaskRouter();
		const created: string[] = [];
		configureAgentProvisioning((role, name) => {
			created.push(role);
			registerAgent(role, name);
		});
		t.deepEqual(getAgentAvailability(), []);
		t.true(ensureFreeAgent('marketing'));
		t.true(ensureFreeAgent('marketing'));
		t.deepEqual(created, ['marketing']);
		t.deepEqual(
			getAgentAvailability().map(agent => agent.role),
			['marketing'],
		);
		resetTaskRouter();
	},
);

test.serial(
	'provisioning enforces total and per-role limits and resets its factory',
	t => {
		resetTaskRouter();
		configureAgentProvisioning((role, name) => registerAgent(role, name), 2, {
			backend: 1,
		});
		t.true(ensureFreeAgent('backend'));
		const backend = getAgentAvailability()[0]!;
		t.false(ensureFreeAgent('backend', backend.agentId));
		t.true(ensureFreeAgent('tester'));
		t.false(ensureFreeAgent('frontend'));
		t.is(getAgentAvailability().length, 2);
		resetTaskRouter();
		t.false(ensureFreeAgent('marketing'));
		t.deepEqual(getAgentAvailability(), []);
	},
);

test.serial(
	'catalog discovery does not create agents and unknown roles are rejected',
	async t => {
		resetTaskRouter();
		const tools = createDelegationTools();
		const catalog = tools.find(tool => tool.name === 'list_agent_roles')!;
		const roles = JSON.parse(await catalog.invoke({})) as Array<{role: string}>;
		t.true(roles.some(item => item.role === 'marketing'));
		t.true(roles.some(item => item.role === 'tester'));
		t.deepEqual(getAgentAvailability(), []);
		const delegate = tools.find(tool => tool.name === 'delegate_role_task')!;
		const result = JSON.parse(
			await delegate.invoke({
				role: 'unknown',
				task: 'test',
				acceptanceCriteria: [],
				dependencies: [],
				completedDependencies: [],
			}),
		);
		t.is(result.status, 'blocked');
		t.deepEqual(getAgentAvailability(), []);
	},
);

test.serial('unfinished dependencies do not create any agents', async t => {
	resetTaskRouter();
	setCoordinatorId('coordinator');
	configureAgentProvisioning((role, name) => registerAgent(role, name));
	const delegate = createDelegationTools().find(
		tool => tool.name === 'delegate_role_task',
	)!;
	const result = JSON.parse(
		await delegate.invoke({
			role: 'tester',
			task: 'Verify feature',
			acceptanceCriteria: [],
			dependencies: ['implementation'],
			completedDependencies: [],
		}),
	);
	t.is(result.status, 'blocked');
	t.deepEqual(getAgentAvailability(), []);
	resetTaskRouter();
});

test.serial(
	'dispatch provisions busy roles and schedules a cold frontend plan',
	async t => {
		t.timeout(10000);
		resetTaskRouter();
		t.teardown(() => resetTaskRouter());
		initializeRuntime({state: new EnvironmentState()});
		const coordinator = createHuman({
			name: 'Test Coordinator',
			capabilities: [],
			handlers: [],
		});
		join(coordinator);
		setCoordinatorId(coordinator.getId());
		const received: string[] = [];
		join(
			createRuntimeObserver(event => {
				if (
					event.type !== 'message.sent' ||
					event.producerId !== coordinator.getId()
				)
					return;
				const {message} = event.payload as {message: string};
				const task = parseTaskEnvelope(message);
				if (!task) return;
				received.push(task.task);
				// Delay completion so simultaneous dispatches must reserve distinct workers.
				setTimeout(() => {
					void createSubmitTaskResultTool(
						task.role,
						() => task.targetAgentId,
					).invoke({
						taskId: task.taskId,
						status: 'done',
						summary: task.task,
						filesChanged: [],
						checks: ['Synthetic worker completed'],
						blockers: [],
					});
				}, 10);
			}),
		);
		configureAgentProvisioning((role, name) => {
			const worker = createHuman({name, capabilities: [], handlers: []});
			registerAgent(role, worker.getId());
			join(worker);
		});
		const tools = createDelegationTools();
		const delegate = tools.find(tool => tool.name === 'delegate_role_task')!;
		const args = {
			role: 'marketing',
			task: 'Write copy',
			acceptanceCriteria: [],
			dependencies: [],
			completedDependencies: [],
		};
		const concurrent = await Promise.all([
			delegate.invoke(args),
			delegate.invoke(args),
		]);
		t.true(concurrent.every(result => JSON.parse(result).status === 'done'));
		t.is(getAgentAvailability().length, 2);
		await delegate.invoke(args);
		t.is(getAgentAvailability().length, 2);
		const plan = tools.find(tool => tool.name === 'delegate_frontend_tasks')!;
		const result = JSON.parse(
			await plan.invoke({
				tasks: [
					{
						key: 'a',
						task: 'First UI part',
						acceptanceCriteria: [],
						dependsOn: [],
					},
					{
						key: 'b',
						task: 'Second UI part',
						acceptanceCriteria: [],
						dependsOn: [],
					},
					{
						key: 'c',
						task: 'Connect UI parts',
						acceptanceCriteria: [],
						dependsOn: ['a', 'b'],
					},
				],
				completedDependencies: [],
			}),
		);
		t.is(result.status, 'done');
		t.is(
			getAgentAvailability().filter(agent => agent.role === 'frontend').length,
			2,
		);
		t.is(getFreeAgentCount('frontend'), 2);
		t.is(getFreeAgentCount('marketing'), 2);
		t.false(getAgentAvailability().some(agent => agent.role === 'backend'));
		t.true(
			received.indexOf('Connect UI parts') > received.indexOf('First UI part'),
		);
		t.true(
			received.indexOf('Connect UI parts') > received.indexOf('Second UI part'),
		);
	},
);
