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
	failAgentTask,
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
			'',
			'Original project requirements and follow-ups (reference material):',
			task.projectBrief ??
				'No source brief was attached; use the assigned task and dependencies.',
		].join('\n');

		const input: InferenceInput = {
			model: 'gpt-5.4',
			context: participant.getMemory().getContext(),
			tools: participant.getTools(),
		};

		void runLoop(participant.getId(), prompt, input).then(
			() =>
				failAgentTask(
					participant.getId(),
					'The agent ended without submitting a task result.',
					task.taskId,
				),
			(error: unknown) =>
				failAgentTask(
					participant.getId(),
					error instanceof Error ? error.message : String(error),
					task.taskId,
				),
		);
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
		instruction: `${config.instruction}
      ${
				config.toolAccess === 'terminal'
					? `      Before working, call get_workspace_info and use the actual workspace path and OS.
      Use list_files/read_file/write_file for source and JSON, creating output directories
      exactly as the original project requirements specify. Read the entire original brief,
      including error precedence and boundary conditions, not just your short task title.
      Do not inspect credential files. Do not copy a pre-existing reference solution.
      For finite checks use run_command and inspect success, stderr and exitCode.
      For servers use start_process, get_process_output, http_request and stop_process;
      npm start in run_command would block until timeout. Test the generated application's
      own directory and environment, keep it standalone, and clean up managed processes.
`
					: 'Use only the supplied requirements and your assigned task. Do not claim workspace or terminal access.'
			}
      Tool calls in one response run concurrently. Batch only independent operations;
      keep dependent commands and changes to the same files in separate responses.
      Call submit_task_result after all assigned work and checks are complete.`,
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
