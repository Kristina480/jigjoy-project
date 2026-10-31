import {
	Agent,
	type InferenceInput,
	type SituationContext,
	type SituationHandler,
	type SituationProcessor,
	SituationSpecification,
	createAgent,
} from '@mozaik-ai/core';

import {runLoop} from '../runtime.js';
import {roleCatalog, type AgentRole} from './role-catalog.js';
import {terminalTools} from '../terminal/tools.js';
import {
	createRequestTaskHelpTool,
	createSubmitTaskResultTool,
	getCoordinatorId,
	parseTaskEnvelope,
	registerAgent,
} from './task-router.js';

class AssignedTaskSpecification extends SituationSpecification {
	constructor(private readonly role: AgentRole) {
		super();
	}

	isSatisfiedBy({event, participant}: SituationContext): boolean {
		if (
			event.type !== 'message.sent' ||
			event.producerId !== getCoordinatorId() ||
			event.producerId === participant.getId()
		) {
			return false;
		}

		const {message} = event.payload as {message: string};
		const task = parseTaskEnvelope(message);
		return (
			task?.role === this.role && task.targetAgentId === participant.getId()
		);
	}
}

class AssignedTaskProcessor implements SituationProcessor {
	constructor(private readonly role: AgentRole) {}

	apply({event, participant}: SituationContext): void {
		if (!(participant instanceof Agent)) {
			return;
		}

		const {message} = event.payload as {message: string};
		const task = parseTaskEnvelope(message);

		if (
			!task ||
			task.role !== this.role ||
			task.targetAgentId !== participant.getId()
		) {
			return;
		}

		const prompt = [
			`Task ID: ${task.taskId}`,
			`Task: ${task.task}`,
			'Acceptance criteria:',
			...task.acceptanceCriteria.map(item => `- ${item}`),
			'Dependencies:',
			...(task.dependencies.length > 0
				? task.dependencies.map(item => `- ${item}`)
				: ['- None']),
			'Completed dependencies:',
			...(task.completedDependencies.length > 0
				? task.completedDependencies.map(item => `- ${item}`)
				: ['- None']),
			'',
			'When finished, call submit_task_result with your result.',
		].join('\n');

		const input: InferenceInput = {
			model: 'gpt-5.4',
			context: participant.getMemory().getContext(),
			tools: participant.getTools(),
		};

		runLoop(participant.getId(), prompt, input);
	}
}

export function createRoleAgent(role: AgentRole, name?: string): Agent {
	const config = roleCatalog[role];
	let participantId = '';

	const handler: SituationHandler = {
		specification: new AssignedTaskSpecification(role),
		processor: new AssignedTaskProcessor(role),
	};

	const agent = createAgent({
		name: name ?? config.name,
		capabilities: ['inference'],
		instruction: config.instruction,
		tools: [
			...(config.toolAccess === 'terminal' ? terminalTools : []),
			createSubmitTaskResultTool(role, () => participantId),
			...(role === 'backend'
				? [createRequestTaskHelpTool(role, () => participantId)]
				: []),
		],
		handlers: [handler],
	});

	participantId = agent.getId();
	registerAgent(role, participantId);
	return agent;
}
