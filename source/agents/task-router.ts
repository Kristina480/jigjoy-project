import {promises as fs} from 'node:fs';
import {workspacePath} from '../terminal/workspace-tools.js';
import {teamRecipes} from './team-recipes.js';
import {SemanticEvent, type Tool} from '@mozaik-ai/core';
import {sendMessage, resolveRuntime} from '../runtime.js';

import {isAgentRole, listAgentRoles, type AgentRole} from './role-catalog.js';
export type {AgentRole} from './role-catalog.js';

export type TaskEnvelope = {
	kind: 'agent.task';
	taskId: string;
	role: AgentRole;
	targetAgentId: string;
	task: string;
	projectBrief?: string;
	acceptanceCriteria: string[];
	dependencies: string[];
	completedDependencies: string[];
};

export type HelpRequestEnvelope = {
	kind: 'agent.help.request';
	requestId: string;
	taskId: string;
	role: 'backend';
	requesterAgentId: string;
	remainingWork: string;
	dependencies: string[];
	completedDependencies: string[];
};

export type TaskResult = {
	status: 'done' | 'blocked';
	summary: string;
	filesChanged: string[];
	checks: string[];
	blockers: string[];
};

type PendingTask = {
	role: AgentRole;
	agentId: string;
	resolve: (result: TaskResult) => void;
};

type RegisteredAgent = {
	id: string;
	role: AgentRole;
	busyTaskId: string | undefined;
};

type PendingHelpRequest = {
	requesterAgentId: string;
	resolve: (result: TaskResult) => void;
};

const pendingTasks = new Map<string, PendingTask>();
const pendingHelpRequests = new Map<string, PendingHelpRequest>();
const registeredAgents = new Map<string, RegisteredAgent>();
const RESULT_TIMEOUT_MS = 30 * 60 * 1000;
const HELP_REQUEST_TIMEOUT_MS = 35 * 60 * 1000;

type AgentFactory = (role: AgentRole, name: string) => void;
let agentFactory: AgentFactory | undefined;
let retireAgent: ((id: string) => void) | undefined;
let maxAgents = 8;
let roleLimits: Partial<Record<AgentRole, number>> = {};

export function configureAgentProvisioning(
	factory: AgentFactory,
	maximum = 8,
	limits: Partial<Record<AgentRole, number>> = {},
	retire?: (id: string) => void,
): void {
	if (!Number.isInteger(maximum) || maximum < 1 || maximum > 32) {
		throw new RangeError('maxAgents must be an integer between 1 and 32.');
	}
	for (const limit of Object.values(limits)) {
		if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
			throw new RangeError(
				'Role limits must be integers between 1 and maxAgents.',
			);
		}
	}
	agentFactory = factory;
	retireAgent = retire;
	maxAgents = maximum;
	roleLimits = {...limits};
}

// Synchronous creation and registration reserve capacity before another dispatch runs.
export function ensureFreeAgent(
	role: AgentRole,
	excludeAgentId?: string,
): boolean {
	if (findFreeAgent(role, excludeAgentId)) return true;
	const count = [...registeredAgents.values()].filter(
		agent => agent.role === role,
	).length;
	if (!agentFactory || count >= (roleLimits[role] ?? 2)) {
		return false;
	}
	if (registeredAgents.size >= maxAgents) {
		const idle = [...registeredAgents.values()].find(
			agent => agent.role !== role && !agent.busyTaskId,
		);
		if (!retireAgent || !idle) return false;
		retireAgent(idle.id);
		registeredAgents.delete(idle.id);
	}
	agentFactory(
		role,
		`${listAgentRoles().find(item => item.role === role)!.name} ${count + 1}`,
	);
	return Boolean(findFreeAgent(role, excludeAgentId));
}

let projectBrief = '';

export function recordProjectMessage(message: string): void {
	projectBrief = projectBrief
		? `${projectBrief}\n\n--- User follow-up ---\n\n${message}`
		: message;
}

export function getProjectBrief(): string {
	return projectBrief;
}

let coordinatorId = '';
let taskCounter = 0;
let helpRequestCounter = 0;

export function setCoordinatorId(id: string): void {
	coordinatorId = id;
}

export function getCoordinatorId(): string {
	return coordinatorId;
}

function finishTask(taskId: string, result: TaskResult): void {
	const pending = pendingTasks.get(taskId);
	if (!pending) return;
	pendingTasks.delete(taskId);
	const agent = registeredAgents.get(pending.agentId);
	if (agent?.busyTaskId === taskId) agent.busyTaskId = undefined;
	resolveRuntime().publish(
		SemanticEvent.create('agent.task.result', pending.agentId, {
			taskId,
			result,
		}),
	);
	pending.resolve(result);
}

export function failAgentTask(
	agentId: string,
	reason: string,
	expectedTaskId?: string,
): void {
	const taskId = registeredAgents.get(agentId)?.busyTaskId;
	if (taskId && (!expectedTaskId || taskId === expectedTaskId))
		finishTask(taskId, blockedResult(reason, [reason]));
}

export function resetTaskRouter(): void {
	for (const pending of pendingTasks.values()) {
		pending.resolve({
			status: 'blocked',
			summary: 'The agent session was reset before this task completed.',
			filesChanged: [],
			checks: [],
			blockers: ['Agent session reset.'],
		});
	}

	for (const pending of pendingHelpRequests.values()) {
		pending.resolve(
			blockedResult('The agent session was reset before help was assigned.', [
				'Agent session reset.',
			]),
		);
	}

	pendingTasks.clear();
	pendingHelpRequests.clear();
	registeredAgents.clear();
	agentFactory = undefined;
	retireAgent = undefined;
	roleLimits = {};
	maxAgents = 8;
	coordinatorId = '';
	projectBrief = '';
}

export function registerAgent(role: AgentRole, id: string): void {
	if (!id) {
		throw new Error('Cannot register an agent without an ID.');
	}

	registeredAgents.set(id, {id, role, busyTaskId: undefined});
}

export type AgentAvailability = {
	agentId: string;
	role: AgentRole;
	status: 'free' | 'busy';
	taskId?: string;
};

export function getAgentAvailability(): AgentAvailability[] {
	return [...registeredAgents.values()].map(agent => ({
		agentId: agent.id,
		role: agent.role,
		status: agent.busyTaskId ? ('busy' as const) : ('free' as const),
		...(agent.busyTaskId ? {taskId: agent.busyTaskId} : {}),
	}));
}

export function getUnresolvedDependencies(
	dependencies: string[],
	completedDependencies: string[],
): string[] {
	const completed = new Set(completedDependencies);
	return dependencies.filter(dependency => !completed.has(dependency));
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function parseTaskEnvelope(message: string): TaskEnvelope | undefined {
	try {
		const value = JSON.parse(message) as Partial<TaskEnvelope>;

		if (
			value.kind !== 'agent.task' ||
			typeof value.taskId !== 'string' ||
			!isAgentRole(value.role) ||
			typeof value.targetAgentId !== 'string' ||
			typeof value.task !== 'string' ||
			!isStringArray(value.acceptanceCriteria) ||
			!isStringArray(value.dependencies) ||
			!isStringArray(value.completedDependencies) ||
			(value.projectBrief !== undefined &&
				typeof value.projectBrief !== 'string')
		) {
			return undefined;
		}

		return value as TaskEnvelope;
	} catch {
		return undefined;
	}
}

export function parseHelpRequestEnvelope(
	message: string,
): HelpRequestEnvelope | undefined {
	try {
		const value = JSON.parse(message) as Partial<HelpRequestEnvelope>;

		if (
			value.kind !== 'agent.help.request' ||
			typeof value.requestId !== 'string' ||
			typeof value.taskId !== 'string' ||
			value.role !== 'backend' ||
			typeof value.requesterAgentId !== 'string' ||
			typeof value.remainingWork !== 'string' ||
			!isStringArray(value.dependencies) ||
			!isStringArray(value.completedDependencies)
		) {
			return undefined;
		}

		return value as HelpRequestEnvelope;
	} catch {
		return undefined;
	}
}

function blockedResult(summary: string, blockers: string[]): TaskResult {
	return {
		status: 'blocked',
		summary,
		filesChanged: [],
		checks: [],
		blockers,
	};
}

function findFreeAgent(
	role: AgentRole,
	excludeAgentId?: string,
): RegisteredAgent | undefined {
	return [...registeredAgents.values()].find(
		agent =>
			agent.role === role && !agent.busyTaskId && agent.id !== excludeAgentId,
	);
}

export function getFreeAgentCount(role: AgentRole): number {
	return [...registeredAgents.values()].filter(
		agent => agent.role === role && !agent.busyTaskId,
	).length;
}

async function dispatchTask(
	role: AgentRole,
	task: string,
	acceptanceCriteria: string[],
	dependencies: string[] = [],
	completedDependencies: string[] = [],
	excludeAgentId?: string,
	sourceBrief = projectBrief,
): Promise<TaskResult> {
	if (!coordinatorId) {
		return blockedResult('Coordinator has not been created.', [
			'Coordinator is unavailable.',
		]);
	}

	const unresolvedDependencies = getUnresolvedDependencies(
		dependencies,
		completedDependencies,
	);

	if (unresolvedDependencies.length > 0) {
		return blockedResult('The task has unfinished dependencies.', [
			...unresolvedDependencies.map(dependency => `Waiting for: ${dependency}`),
		]);
	}

	try {
		ensureFreeAgent(role, excludeAgentId);
	} catch (error) {
		return blockedResult(`Could not create a ${role} agent.`, [String(error)]);
	}
	const agent = findFreeAgent(role, excludeAgentId);

	if (!agent) {
		return blockedResult(`No free ${role} agent is available.`, [
			excludeAgentId
				? `No free ${role} agent other than ${excludeAgentId} is available.`
				: `All ${role} agents are busy or none are registered.`,
		]);
	}

	const taskId = `${Date.now()}-${++taskCounter}`;
	agent.busyTaskId = taskId;

	let timeout: ReturnType<typeof setTimeout> | undefined;
	const resultPromise = new Promise<TaskResult>(resolve => {
		pendingTasks.set(taskId, {role, agentId: agent.id, resolve});

		timeout = setTimeout(() => {
			const pending = pendingTasks.get(taskId);

			if (!pending) {
				return;
			}

			finishTask(
				taskId,
				blockedResult(`${role} agent timed out.`, [
					`No result received within ${RESULT_TIMEOUT_MS / 60000} minutes.`,
				]),
			);
		}, RESULT_TIMEOUT_MS);
	});

	const envelope: TaskEnvelope = {
		kind: 'agent.task',
		taskId,
		role,
		targetAgentId: agent.id,
		task,
		projectBrief: sourceBrief,
		acceptanceCriteria,
		dependencies,
		completedDependencies,
	};

	try {
		sendMessage(JSON.stringify(envelope), coordinatorId);
	} catch (error) {
		const pending = pendingTasks.get(taskId);

		if (pending)
			finishTask(
				taskId,
				blockedResult('The task could not be sent to its assigned agent.', [
					error instanceof Error ? error.message : String(error),
				]),
			);
	}

	try {
		return await resultPromise;
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}

		if (agent.busyTaskId === taskId) {
			agent.busyTaskId = undefined;
		}

		pendingTasks.delete(taskId);
	}
}

function createDelegateTool(role: AgentRole): Tool {
	return {
		name: `delegate_${role}_task`,
		description: `Assign a task to the ${role} agent and wait for its result.`,
		parameters: {
			type: 'object',
			properties: {
				task: {
					type: 'string',
					description: 'The task to perform.',
				},
				acceptanceCriteria: {
					type: 'array',
					items: {type: 'string'},
					description: 'Conditions that must be met.',
				},
				dependencies: {
					type: 'array',
					items: {type: 'string'},
					description: 'Prerequisites for this task.',
				},
				completedDependencies: {
					type: 'array',
					items: {type: 'string'},
					description: 'Prerequisites that are already complete.',
				},
			},
			required: [
				'task',
				'acceptanceCriteria',
				'dependencies',
				'completedDependencies',
			],
		},
		strict: true,
		type: 'function',
		invoke: async (args: {
			task: string;
			acceptanceCriteria: string[];
			dependencies: string[];
			completedDependencies: string[];
		}) => {
			const result = await dispatchTask(
				role,
				args.task,
				args.acceptanceCriteria,
				args.dependencies,
				args.completedDependencies,
			);

			return JSON.stringify(result);
		},
	};
}

export function createRequestTaskHelpTool(
	role: 'backend',
	getProducerId: () => string,
): Tool {
	return {
		name: 'request_task_help',
		description:
			'Ask the coordinator to reassign remaining work. Include its dependencies and which ones are complete.',
		parameters: {
			type: 'object',
			properties: {
				taskId: {type: 'string'},
				remainingWork: {type: 'string'},
				dependencies: {
					type: 'array',
					items: {type: 'string'},
				},
				completedDependencies: {
					type: 'array',
					items: {type: 'string'},
				},
			},
			required: [
				'taskId',
				'remainingWork',
				'dependencies',
				'completedDependencies',
			],
		},
		strict: true,
		type: 'function',
		invoke: async (args: {
			taskId: string;
			remainingWork: string;
			dependencies: string[];
			completedDependencies: string[];
		}) => {
			if (!coordinatorId) {
				throw new Error('Coordinator has not been created.');
			}

			const producerId = getProducerId();

			if (!producerId) {
				throw new Error('Requesting agent has not been initialized.');
			}

			const request: HelpRequestEnvelope = {
				kind: 'agent.help.request',
				requestId: `${Date.now()}-${++helpRequestCounter}`,
				taskId: args.taskId,
				role,
				requesterAgentId: producerId,
				remainingWork: args.remainingWork,
				dependencies: args.dependencies,
				completedDependencies: args.completedDependencies,
			};

			let timeout: ReturnType<typeof setTimeout> | undefined;
			const resultPromise = new Promise<TaskResult>(resolve => {
				pendingHelpRequests.set(request.requestId, {
					requesterAgentId: producerId,
					resolve,
				});

				timeout = setTimeout(() => {
					const pending = pendingHelpRequests.get(request.requestId);

					if (!pending) {
						return;
					}

					pendingHelpRequests.delete(request.requestId);
					pending.resolve(
						blockedResult('The coordinator did not process the help request.', [
							`No handoff decision was received within ${
								HELP_REQUEST_TIMEOUT_MS / 60000
							} minutes.`,
						]),
					);
				}, HELP_REQUEST_TIMEOUT_MS);
			});

			try {
				sendMessage(JSON.stringify(request), producerId);
			} catch (error) {
				const pending = pendingHelpRequests.get(request.requestId);

				if (pending) {
					pendingHelpRequests.delete(request.requestId);
					pending.resolve(
						blockedResult('The help request could not be sent.', [
							error instanceof Error ? error.message : String(error),
						]),
					);
				}
			}

			try {
				const result = await resultPromise;
				return JSON.stringify({requestId: request.requestId, result});
			} finally {
				if (timeout) {
					clearTimeout(timeout);
				}

				pendingHelpRequests.delete(request.requestId);
			}
		},
	};
}

function createFullStackTool(): Tool {
	return {
		name: 'delegate_frontend_and_backend',
		description:
			'Run frontend and backend tasks in parallel using the same API contract.',
		parameters: {
			type: 'object',
			properties: {
				frontendTask: {type: 'string'},
				backendTask: {type: 'string'},
				apiContract: {type: 'string'},
				acceptanceCriteria: {
					type: 'array',
					items: {type: 'string'},
				},
				dependencies: {
					type: 'array',
					items: {type: 'string'},
				},
				completedDependencies: {
					type: 'array',
					items: {type: 'string'},
				},
			},
			required: [
				'frontendTask',
				'backendTask',
				'apiContract',
				'acceptanceCriteria',
				'dependencies',
				'completedDependencies',
			],
		},
		strict: true,
		type: 'function',
		invoke: async (args: {
			frontendTask: string;
			backendTask: string;
			apiContract: string;
			acceptanceCriteria: string[];
			dependencies: string[];
			completedDependencies: string[];
		}) => {
			const [frontend, backend] = await Promise.all([
				dispatchTask(
					'frontend',
					`${args.frontendTask}\n\nAPI contract:\n${args.apiContract}`,
					args.acceptanceCriteria,
					args.dependencies,
					args.completedDependencies,
				),
				dispatchTask(
					'backend',
					`${args.backendTask}\n\nAPI contract:\n${args.apiContract}`,
					args.acceptanceCriteria,
					args.dependencies,
					args.completedDependencies,
				),
			]);

			return JSON.stringify({frontend, backend});
		},
	};
}

type AgentPlanTask = {
	key: string;
	role: AgentRole;
	task: string;
	acceptanceCriteria: string[];
	dependsOn: string[];
};

function getDispatchCapacity(role: AgentRole): number {
	const free = getFreeAgentCount(role);
	if (!agentFactory) return free;
	const count = [...registeredAgents.values()].filter(
		agent => agent.role === role,
	).length;
	return (
		free +
		Math.max(
			0,
			Math.min(
				maxAgents -
					registeredAgents.size +
					(retireAgent
						? [...registeredAgents.values()].filter(
								agent => agent.role !== role && !agent.busyTaskId,
						  ).length
						: 0),
				(roleLimits[role] ?? 2) - count,
			),
		)
	);
}

async function runTaskPlan(
	tasks: AgentPlanTask[],
	completedDependencies: string[],
) {
	const sourceBrief = projectBrief;
	if (tasks.length === 0)
		return blockedResult('No tasks were provided.', [
			'Add at least one task to the plan.',
		]);
	if (
		tasks.some(
			task =>
				!task ||
				typeof task.key !== 'string' ||
				typeof task.task !== 'string' ||
				!task.task.trim() ||
				!isStringArray(task.acceptanceCriteria) ||
				!isStringArray(task.dependsOn),
		)
	) {
		return blockedResult('Invalid task shape.', [
			'Each task needs key, task, acceptanceCriteria and dependsOn with the expected types.',
		]);
	}

	const taskKeys = new Set(tasks.map(task => task.key));
	if (taskKeys.size !== tasks.length || tasks.some(task => !task.key.trim())) {
		return blockedResult('Task keys must be unique and nonempty.', [
			'Give every task a distinct nonempty key.',
		]);
	}
	if (tasks.some(task => !isAgentRole(task.role))) {
		return blockedResult('Unknown agent role.', [
			'Choose roles from list_agent_roles.',
		]);
	}
	// A caller cannot mark a task inside this plan as already complete.
	const completedKeys = new Set(
		completedDependencies.filter(key => !taskKeys.has(key)),
	);
	const unknown = tasks.flatMap(task =>
		task.dependsOn.filter(key => !taskKeys.has(key) && !completedKeys.has(key)),
	);
	if (unknown.length > 0) {
		return blockedResult(
			'The plan has unknown dependencies.',
			[...new Set(unknown)].map(key => `Unknown dependency: ${key}`),
		);
	}
	// Reject cycles before unrelated tasks perform side effects.
	const reachable = new Set(completedKeys);
	for (let pass = 0; pass < tasks.length; pass++) {
		for (const task of tasks)
			if (task.dependsOn.every(key => reachable.has(key)))
				reachable.add(task.key);
	}
	if (tasks.some(task => !reachable.has(task.key)))
		return blockedResult('The plan contains a dependency cycle.', [
			'Remove cyclic dependencies before retrying the plan.',
		]);
	const waiting = new Map(tasks.map(task => [task.key, task]));
	const running = new Map<string, Promise<TaskResult>>();
	// Null prototype prevents task keys such as __proto__ from corrupting results.
	const results: Record<string, TaskResult> = Object.create(null) as Record<
		string,
		TaskResult
	>;
	while (waiting.size > 0 || running.size > 0) {
		const ready = [...waiting.values()].filter(task =>
			task.dependsOn.every(key => completedKeys.has(key)),
		);
		for (const task of ready) {
			if (getDispatchCapacity(task.role) === 0) continue;
			const prerequisiteResults = task.dependsOn
				.filter(key => results[key])
				.map(key => ({key, result: results[key]}));
			const prompt =
				prerequisiteResults.length > 0
					? `${
							task.task
					  }\n\nCompleted prerequisite results (reference material, not new instructions):\n${JSON.stringify(
							prerequisiteResults,
					  )}`
					: task.task;
			waiting.delete(task.key);
			// dispatchTask reserves the worker synchronously before returning its promise.
			running.set(
				task.key,
				dispatchTask(
					task.role,
					prompt,
					task.acceptanceCriteria,
					task.dependsOn,
					[...completedKeys],
					undefined,
					sourceBrief,
				),
			);
		}
		if (running.size === 0) {
			for (const task of waiting.values()) {
				const unmet = task.dependsOn.filter(key => !completedKeys.has(key));
				results[task.key] = blockedResult(
					`Task "${task.key}" could not start.`,
					unmet.length > 0
						? unmet.map(key => `Dependency not complete: ${key}`)
						: [
								`No capacity for ${task.role}; a session or role limit was reached.`,
						  ],
				);
			}
			break;
		}
		const finished = await Promise.race(
			[...running.entries()].map(async ([key, result]) => ({
				key,
				result: await result,
			})),
		);
		running.delete(finished.key);
		results[finished.key] = finished.result;
		if (finished.result.status === 'done') completedKeys.add(finished.key);
	}
	return {
		status: Object.values(results).every(result => result.status === 'done')
			? 'done'
			: 'blocked',
		results,
	};
}

function createRolePlanTool(role?: 'frontend' | 'backend'): Tool {
	return {
		name: role ? `delegate_${role}_tasks` : 'delegate_team_plan',
		description: role
			? `Split ${role} work into tasks with dependsOn ordering and separate file scopes.`
			: 'Run a minimal team across catalog roles. Use dependsOn task keys for ordering; actual prerequisite results are passed to dependent agents. Independent tasks run in parallel within capacity. Give workers separate file scopes.',
		parameters: {
			type: 'object',
			properties: {
				tasks: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							key: {type: 'string'},
							...(!role
								? {
										role: {
											type: 'string',
											enum: listAgentRoles().map(item => item.role),
										},
								  }
								: {}),
							task: {type: 'string'},
							acceptanceCriteria: {type: 'array', items: {type: 'string'}},
							dependsOn: {type: 'array', items: {type: 'string'}},
						},
						required: [
							'key',
							...(!role ? ['role'] : []),
							'task',
							'acceptanceCriteria',
							'dependsOn',
						],
					},
				},
				completedDependencies: {type: 'array', items: {type: 'string'}},
			},
			required: ['tasks', 'completedDependencies'],
		},
		strict: true,
		type: 'function',
		invoke: async (args: {
			tasks: Array<Omit<AgentPlanTask, 'role'> & {role?: AgentRole}>;
			completedDependencies: string[];
		}) => {
			if (
				!args ||
				!Array.isArray(args.tasks) ||
				!isStringArray(args.completedDependencies)
			)
				return JSON.stringify(
					blockedResult('Invalid plan.', [
						'tasks must be an array and completedDependencies must be a string array.',
					]),
				);
			const tasks = args.tasks.map(task => ({
				...task,
				role: role ?? task?.role,
			})) as AgentPlanTask[];
			return JSON.stringify(
				await runTaskPlan(tasks, args.completedDependencies),
			);
		},
	};
}

function createHelpDelegationTool(): Tool {
	return {
		name: 'delegate_remaining_backend_task',
		description:
			'Assign a backend help request to a free backend agent other than the requesting agent. The router checks dependencies and availability.',
		parameters: {
			type: 'object',
			properties: {
				requestId: {type: 'string'},
				requesterAgentId: {type: 'string'},
				task: {type: 'string'},
				acceptanceCriteria: {
					type: 'array',
					items: {type: 'string'},
				},
				dependencies: {
					type: 'array',
					items: {type: 'string'},
				},
				completedDependencies: {
					type: 'array',
					items: {type: 'string'},
				},
			},
			required: [
				'requestId',
				'requesterAgentId',
				'task',
				'acceptanceCriteria',
				'dependencies',
				'completedDependencies',
			],
		},
		strict: true,
		type: 'function',
		invoke: async (args: {
			requestId: string;
			requesterAgentId: string;
			task: string;
			acceptanceCriteria: string[];
			dependencies: string[];
			completedDependencies: string[];
		}) => {
			const pending = pendingHelpRequests.get(args.requestId);

			if (!pending || pending.requesterAgentId !== args.requesterAgentId) {
				return JSON.stringify(
					blockedResult('The help request is no longer active.', [
						'No matching Backend help request is waiting for this handoff.',
					]),
				);
			}

			const result = await dispatchTask(
				'backend',
				args.task,
				args.acceptanceCriteria,
				args.dependencies,
				args.completedDependencies,
				args.requesterAgentId,
			);

			pendingHelpRequests.delete(args.requestId);
			pending.resolve(result);

			return JSON.stringify(result);
		},
	};
}

function createAgentAvailabilityTool(): Tool {
	return {
		name: 'get_agent_availability',
		description:
			'List every registered agent and whether it is free or busy on a task.',
		parameters: {
			type: 'object',
			properties: {},
			required: [],
		},
		strict: true,
		type: 'function',
		invoke: async () => JSON.stringify(getAgentAvailability()),
	};
}

export function createDelegationTools(): Tool[] {
	return [
		{
			name: 'load_project_requirements',
			description:
				'Read the user-designated requirements file in full and attach it to every subsequent worker task. Call and inspect this BEFORE creating a plan, not in the same parallel batch.',
			parameters: {
				type: 'object',
				properties: {path: {type: 'string'}},
				required: ['path'],
			},
			strict: true,
			type: 'function',
			invoke: async (args: {path: string}) => {
				const text = await fs.readFile(workspacePath(args.path), 'utf8');
				if (!text.trim()) throw new Error('The requirements file is empty.');
				recordProjectMessage(`Requirements file ${args.path}:\n\n${text}`);
				return {path: args.path, characters: text.length, requirements: text};
			},
		},
		{
			name: 'get_team_guidance',
			description:
				'Discover small example teams and their dependency order. Adapt to scope; do not create every suggested role. UI design implementation requires designer then frontend.',
			parameters: {type: 'object', properties: {}, required: []},
			strict: true,
			type: 'function',
			invoke: async () => JSON.stringify(teamRecipes),
		},
		createRolePlanTool(),
		{
			name: 'list_agent_roles',
			description:
				'Discover available specialist roles before choosing a minimal team. Listing roles does not create agents.',
			parameters: {type: 'object', properties: {}, required: []},
			strict: true,
			type: 'function',
			invoke: async () => JSON.stringify(listAgentRoles()),
		},
		{
			name: 'delegate_role_task',
			description:
				'Assign a task to a catalog role. Reuse a free agent or create one on demand within capacity limits.',
			parameters: {
				type: 'object',
				properties: {
					role: {type: 'string', enum: listAgentRoles().map(item => item.role)},
					task: {type: 'string'},
					acceptanceCriteria: {type: 'array', items: {type: 'string'}},
					dependencies: {type: 'array', items: {type: 'string'}},
					completedDependencies: {type: 'array', items: {type: 'string'}},
				},
				required: [
					'role',
					'task',
					'acceptanceCriteria',
					'dependencies',
					'completedDependencies',
				],
			},
			strict: true,
			type: 'function',
			invoke: async (args: {
				role: string;
				task: string;
				acceptanceCriteria: string[];
				dependencies: string[];
				completedDependencies: string[];
			}) => {
				if (!isAgentRole(args.role))
					return JSON.stringify(
						blockedResult('Unknown agent role.', [
							'Choose a role from list_agent_roles.',
						]),
					);
				return JSON.stringify(
					await dispatchTask(
						args.role,
						args.task,
						args.acceptanceCriteria,
						args.dependencies,
						args.completedDependencies,
					),
				);
			},
		},
		createAgentAvailabilityTool(),
		createDelegateTool('frontend'),
		createDelegateTool('backend'),
		createDelegateTool('integration'),
		createDelegateTool('quality'),
		createDelegateTool('pr_finalizer'),
		createRolePlanTool('frontend'),
		createRolePlanTool('backend'),
		createHelpDelegationTool(),
		createFullStackTool(),
	];
}

export function createSubmitTaskResultTool(
	role: AgentRole,
	getAgentId: () => string,
): Tool {
	return {
		name: 'submit_task_result',
		description: 'Return this task result to the coordinator.',
		parameters: {
			type: 'object',
			properties: {
				taskId: {type: 'string'},
				status: {type: 'string', enum: ['done', 'blocked']},
				summary: {type: 'string'},
				filesChanged: {
					type: 'array',
					items: {type: 'string'},
				},
				checks: {
					type: 'array',
					items: {type: 'string'},
				},
				blockers: {
					type: 'array',
					items: {type: 'string'},
				},
			},
			required: [
				'taskId',
				'status',
				'summary',
				'filesChanged',
				'checks',
				'blockers',
			],
		},
		strict: true,
		type: 'function',
		invoke: async (args: TaskResult & {taskId: string}) => {
			const pending = pendingTasks.get(args.taskId);
			const agentId = getAgentId();

			if (!pending || pending.role !== role || pending.agentId !== agentId) {
				return {
					accepted: false,
					error:
						'No matching task is waiting. Use the exact Task ID from your assignment.',
				};
			}

			if (args.status !== 'done' && args.status !== 'blocked')
				return {accepted: false, error: 'Invalid status: use done or blocked.'};
			if (
				typeof args.summary !== 'string' ||
				!isStringArray(args.filesChanged) ||
				!isStringArray(args.checks) ||
				!isStringArray(args.blockers)
			)
				return {
					accepted: false,
					error:
						'summary must be a string; filesChanged, checks and blockers must be string arrays.',
				};
			const status = args.blockers.length > 0 ? 'blocked' : args.status;
			finishTask(args.taskId, {
				status,
				summary: args.summary,
				filesChanged: args.filesChanged,
				checks: args.checks,
				blockers: args.blockers,
			});
			return {accepted: true, taskId: args.taskId, status};
		},
	};
}

export function createCoordinatorTools(): Tool[] {
	const names = new Set([
		'list_agent_roles',
		'load_project_requirements',
		'get_team_guidance',
		'get_agent_availability',
		'delegate_team_plan',
		'delegate_remaining_backend_task',
	]);
	return createDelegationTools().filter(tool => names.has(tool.name));
}
