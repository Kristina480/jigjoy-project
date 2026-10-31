import test from 'ava';
import {createHuman} from '@mozaik-ai/core';
import {
	EnvironmentState,
	initializeRuntime,
	join,
	leave,
	resolveParticipant,
} from '../runtime.js';
import {createRuntimeObserver} from '../runtime-observer.js';
import type {TaskEnvelope} from './task-router.js';

import {
	createSubmitTaskResultTool,
	configureAgentProvisioning,
	createDelegationTools,
	ensureFreeAgent,
	setCoordinatorId,
	getAgentAvailability,
	recordProjectMessage,
	getProjectBrief,
	getFreeAgentCount,
	getUnresolvedDependencies,
	parseHelpRequestEnvelope,
	parseTaskEnvelope,
	registerAgent,
	resetTaskRouter,
} from './task-router.js';

initializeRuntime({state: new EnvironmentState()});

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
				received.push(task.task.split('\n')[0]!);
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

function createSyntheticTeam(blockDesigner = false) {
	resetTaskRouter();
	const coordinator = createHuman({
		name: 'Team Test Coordinator',
		capabilities: [],
		handlers: [],
	});
	join(coordinator);
	setCoordinatorId(coordinator.getId());
	const dispatched: TaskEnvelope[] = [];
	const completed: string[] = [];
	const rosters: string[][] = [];
	join(
		createRuntimeObserver(event => {
			if (
				event.type !== 'message.sent' ||
				event.producerId !== coordinator.getId()
			)
				return;
			const task = parseTaskEnvelope(
				(event.payload as {message: string}).message,
			);
			if (!task) return;
			dispatched.push(task);
			rosters.push(getAgentAvailability().map(agent => agent.role));
			setTimeout(() => {
				const blocked = blockDesigner && task.role === 'designer';
				completed.push(task.role);
				void createSubmitTaskResultTool(
					task.role,
					() => task.targetAgentId,
				).invoke({
					taskId: task.taskId,
					status: blocked ? 'blocked' : 'done',
					summary:
						task.role === 'designer'
							? 'Design specification: violet buttons, visible focus, 24px spacing.'
							: `${task.role} finished`,
					filesChanged: [],
					checks: [],
					blockers: blocked ? ['Missing design requirement.'] : [],
				});
			}, 10);
		}),
	);
	configureAgentProvisioning((role, name) => {
		const worker = createHuman({name, capabilities: [], handlers: []});
		registerAgent(role, worker.getId());
		join(worker);
	});
	const plan = createDelegationTools().find(
		tool => tool.name === 'delegate_team_plan',
	)!;
	return {plan, dispatched, completed, rosters};
}

const designTeamTasks = [
	{
		key: 'design',
		role: 'designer',
		task: 'Specify screen design',
		acceptanceCriteria: [],
		dependsOn: [],
	},
	{
		key: 'ui',
		role: 'frontend',
		task: 'Implement screen design',
		acceptanceCriteria: [],
		dependsOn: ['design'],
	},
	{
		key: 'check',
		role: 'tester',
		task: 'Verify screen design',
		acceptanceCriteria: [],
		dependsOn: ['ui'],
	},
];

test.serial(
	'design team passes the actual design to frontend and creates workers in dependency order',
	async t => {
		t.timeout(10000);
		t.teardown(() => resetTaskRouter());
		const {plan, dispatched, completed, rosters} = createSyntheticTeam();
		const result = JSON.parse(
			await plan.invoke({tasks: designTeamTasks, completedDependencies: []}),
		);
		t.is(result.status, 'done');
		t.deepEqual(
			dispatched.map(task => task.role),
			['designer', 'frontend', 'tester'],
		);
		t.deepEqual(completed, ['designer', 'frontend', 'tester']);
		t.deepEqual(rosters, [
			['designer'],
			['designer', 'frontend'],
			['designer', 'frontend', 'tester'],
		]);
		t.true(
			dispatched[1]!.task.includes(
				'violet buttons, visible focus, 24px spacing',
			),
		);
		t.true(dispatched[2]!.task.includes('frontend finished'));
		t.false(
			getAgentAvailability().some(
				agent => agent.role === 'backend' || agent.role === 'marketing',
			),
		);
	},
);

test.serial(
	'blocked design never creates frontend or tester, even when caller marks it completed',
	async t => {
		t.timeout(10000);
		t.teardown(() => resetTaskRouter());
		const {plan, dispatched} = createSyntheticTeam(true);
		const result = JSON.parse(
			await plan.invoke({
				tasks: designTeamTasks,
				completedDependencies: ['design', 'ui'],
			}),
		);
		t.is(result.status, 'blocked');
		t.is(result.results.ui.status, 'blocked');
		t.is(result.results.check.status, 'blocked');
		t.deepEqual(
			dispatched.map(task => task.role),
			['designer'],
		);
		t.deepEqual(
			getAgentAvailability().map(agent => agent.role),
			['designer'],
		);
	},
);

test.serial(
	'team plans reject unknown roles and dependencies without creating workers',
	async t => {
		resetTaskRouter();
		t.teardown(() => resetTaskRouter());
		const plan = createDelegationTools().find(
			tool => tool.name === 'delegate_team_plan',
		)!;
		for (const tasks of [
			[{...designTeamTasks[0], role: 'invented_role'}],
			[{...designTeamTasks[0], dependsOn: ['unknown']}],
			[designTeamTasks[0], designTeamTasks[0]],
			[],
		]) {
			const result = JSON.parse(
				await plan.invoke({tasks, completedDependencies: []}),
			);
			t.is(result.status, 'blocked');
			t.deepEqual(getAgentAvailability(), []);
		}
	},
);

test.serial(
	'team plan detects dependency cycles without creating workers',
	async t => {
		resetTaskRouter();
		t.teardown(() => resetTaskRouter());
		const plan = createDelegationTools().find(
			tool => tool.name === 'delegate_team_plan',
		)!;
		const result = JSON.parse(
			await plan.invoke({
				tasks: [{...designTeamTasks[0], dependsOn: ['ui']}, designTeamTasks[1]],
				completedDependencies: [],
			}),
		);
		t.is(result.status, 'blocked');
		t.deepEqual(getAgentAvailability(), []);
	},
);

test.serial(
	'every dependent task receives the same unabridged source brief snapshot',
	async t => {
		t.timeout(10000);
		t.teardown(() => resetTaskRouter());
		const {plan, dispatched} = createSyntheticTeam();
		const specification =
			'Box Office API\nHOLD_SECONDS=600\nAuth before input\nSix-ticket cap\nFIFO waitlist\nRevenue report\n' +
			'Long requirement. '.repeat(1000);
		recordProjectMessage(specification);
		const pending = plan.invoke({
			tasks: designTeamTasks,
			completedDependencies: [],
		});
		recordProjectMessage(
			'A later queued follow-up must not rewrite the plan already running.',
		);
		const result = JSON.parse(await pending);
		t.is(result.status, 'done');
		t.true(dispatched.every(task => task.projectBrief === specification));
		t.true(getProjectBrief().includes('later queued follow-up'));
		resetTaskRouter();
		t.is(getProjectBrief(), '');
	},
);

test.serial(
	'idle role instances can be retired at capacity while busy workers remain protected',
	async t => {
		t.timeout(10000);
		t.teardown(() => resetTaskRouter());
		const {plan, dispatched} = createSyntheticTeam();
		const retired: string[] = [];
		configureAgentProvisioning(
			(role, name) => {
				const worker = createHuman({name, capabilities: [], handlers: []});
				registerAgent(role, worker.getId());
				join(worker);
			},
			1,
			{},
			id => {
				retired.push(id);
				leave(resolveParticipant(id));
			},
		);
		const pending = plan.invoke({
			tasks: designTeamTasks,
			completedDependencies: [],
		});
		t.false(ensureFreeAgent('marketing'));
		const result = JSON.parse(await pending);
		t.is(result.status, 'done');
		t.deepEqual(
			dispatched.map(task => task.role),
			['designer', 'frontend', 'tester'],
		);
		t.is(retired.length, 2);
		t.deepEqual(
			getAgentAvailability().map(agent => agent.role),
			['tester'],
		);
	},
);

test.serial(
	'malformed task plans return blockers rather than throwing',
	async t => {
		resetTaskRouter();
		t.teardown(() => resetTaskRouter());
		const plan = createDelegationTools().find(
			tool => tool.name === 'delegate_team_plan',
		)!;
		for (const args of [
			{tasks: null, completedDependencies: []},
			{tasks: [{key: 42}], completedDependencies: []},
			{tasks: [null], completedDependencies: []},
		]) {
			const result = JSON.parse(await plan.invoke(args));
			t.is(result.status, 'blocked');
		}
		t.deepEqual(getAgentAvailability(), []);
	},
);

test.serial(
	'a reported blocker overrides a contradictory done status and stops dependent work',
	async t => {
		t.timeout(10000);
		t.teardown(() => resetTaskRouter());
		const {plan, dispatched} = createSyntheticTeam();
		const pending = plan.invoke({
			tasks: designTeamTasks,
			completedDependencies: [],
		});
		const assigned = dispatched[0]!;
		const accepted = await createSubmitTaskResultTool(
			assigned.role,
			() => assigned.targetAgentId,
		).invoke({
			taskId: assigned.taskId,
			status: 'done',
			summary: 'Review found a problem.',
			filesChanged: [],
			checks: [],
			blockers: ['A required check failed.'],
		});
		t.true(accepted.accepted);
		const result = JSON.parse(await pending);
		t.is(result.status, 'blocked');
		t.is(result.results.design.status, 'blocked');
		t.deepEqual(
			dispatched.map(task => task.role),
			['designer'],
		);
	},
);
