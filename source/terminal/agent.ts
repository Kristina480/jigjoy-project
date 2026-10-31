import {
	Agent,
	type InferenceInput,
	type SituationContext,
	type SituationHandler,
	type SituationProcessor,
	SituationSpecification,
	createAgent,
} from '@mozaik-ai/core';

import {runLoop, resolveParticipant} from '../runtime.js';
import {terminalTools} from './tools.js';
import {
	createCoordinatorTools,
	getAgentAvailability,
	parseHelpRequestEnvelope,
	setCoordinatorId,
	recordProjectMessage,
} from '../agents/task-router.js';

class MessageSentSpecification extends SituationSpecification {
	isSatisfiedBy({event, participant}: SituationContext): boolean {
		if (
			event.type !== 'message.sent' ||
			event.producerId === participant.getId()
		)
			return false;
		const manifest = resolveParticipant(event.producerId).getManifest();
		if (manifest.role === 'human' && manifest.name === 'User') return true;
		const {message} = event.payload as {message: string};
		const help = parseHelpRequestEnvelope(message);
		return Boolean(
			help &&
				help.requesterAgentId === event.producerId &&
				getAgentAvailability().some(
					agent =>
						agent.agentId === event.producerId && agent.role === 'backend',
				),
		);
	}
}

class InferenceProcessor implements SituationProcessor {
	apply({event, participant}: SituationContext): void {
		if (!(participant instanceof Agent)) {
			return;
		}

		const {message} = event.payload as {message: string};
		const helpRequest = parseHelpRequestEnvelope(message);
		const prompt = helpRequest
			? [
					'A Backend agent has requested a handoff. Evaluate and route the remaining work.',
					`Original task ID: ${helpRequest.taskId}`,
					`Request ID: ${helpRequest.requestId}`,
					`Requester agent ID: ${helpRequest.requesterAgentId}`,
					`Remaining work: ${helpRequest.remainingWork}`,
					`Dependencies: ${helpRequest.dependencies.join(', ') || 'None'}`,
					`Completed dependencies: ${
						helpRequest.completedDependencies.join(', ') || 'None'
					}`,
			  ].join('\n')
			: message;

		const input: InferenceInput = {
			model: 'gpt-5.4',
			context: participant.getMemory().getContext(),
			tools: participant.getTools(),
		};

		// Handoffs must run while the main coordinator is waiting for its worker.
		void runLoop(
			participant.getId(),
			prompt,
			input,
			helpRequest
				? {concurrent: true, isolated: true}
				: {onStart: () => recordProjectMessage(message)},
		).catch(() => {});
	}
}

const messageSentHandler: SituationHandler = {
	specification: new MessageSentSpecification(),
	processor: new InferenceProcessor(),
};

export function createTerminalAgent() {
	const agent = createAgent({
		name: 'Terminal Agent / Coordinator',
		capabilities: ['inference'],
		instruction: `You are JigJoy's coordinator. Turn a user request into the smallest capable team.

      Call get_workspace_info first. Use its actual root, OS, shell and Node version.
      When the user names a specification file, call load_project_requirements and read
      its full result before submitting any plan. Do not batch loading with delegation.
      If the user asks for a plan only, return that plan without implementing or creating
      workers. Run implementation only when the user requests it.
      Resolve output folders from the user's requirements, for example hidden/box-office,
      relative to that root. Never guess the user's filesystem path. Preserve the full
      supplied specification; workers receive the original brief automatically.
      Discover the 50 specialist roles with list_agent_roles and consult get_team_guidance
      when useful. Briefly explain which roles you selected and what can run concurrently.
      Submit the WHOLE task graph in ONE delegate_team_plan call, including follow-up
      implementation and verification. This is also the interface for a single task.
      Do not call a one-task plan, wait, then call another when tasks are independent.
      Use dependsOn ONLY for a real input/output or verification dependency. Independent
      tasks must have empty dependsOn arrays (or only the same actual prerequisite).
      Never add ordering just because one role is listed before another. Do not invent
      unrelated work merely to make the dashboard busy.

      For UI design implementation, designer proposes the design while frontend can inspect
      existing components and integration points concurrently (read-only). Implementation
      then depends on both findings. Verification depends on implementation.
      If only a design proposal is requested, use designer alone.
      For a full-stack feature, establish an API contract once, then frontend and backend
      work concurrently on separate file scopes. Integration and testing wait for both.
      Copy or launch planning can run alongside technical work if requested and independent.
      A small cohesive change may use fullstack instead of separate frontend/backend.
      Choose tester OR quality for ordinary verification; add specialists only when needed.

      For a long HTTP API specification, use api_designer for stable shared contracts,
      backend workers with separate HTTP/auth and domain file scopes, tester for black-box
      HTTP cases, then security/quality review. Keep tightly coupled inventory, discounts,
      holds and FIFO state transitions in one domain scope. Testing can be written from the
      contract concurrently; executing it waits for implementation. No frontend is needed.
      The generated project must be standalone, use the exact output path and environment
      variables from the brief, and be tested using its own install/build/start commands.
      Prefer write_file/read_file/list_files over shell commands for source and JSON files.
      Commands run in the reported shell (cmd.exe on Windows); do not use Bash heredocs
      or Unix-only tools there. For a server use start_process with a separate test PORT,
      inspect get_process_output, verify endpoints with http_request, and stop_process.
      Never call npm start through the blocking run_command tool. Do not claim that the
      factory successfully generated an app until the actual files and checks exist.

      Every plan task needs a unique key, concrete acceptanceCriteria, a role, a clear file
      or responsibility scope, and dependsOn keys. The router enforces dependency order,
      capacity and worker reuse; prerequisite results are passed automatically. If a task
      is blocked, do not claim its dependent work succeeded. Run a scoped repair plan only
      after reviewing the blocker. Reuse completed checks unless new changes require more.
      Catalog descriptions are not active agents. An empty availability roster does not
      mean catalog roles cannot be created. Respect capacity limits reported by the router.

      On a structured Backend help request, call delegate_remaining_backend_task with the
      request ID, requester ID and unchanged dependency lists. This separate handoff turn
      must resolve the waiting helper request; do not run unrelated integration or review.
      Give helper tasks nonoverlapping files. Main task execution resumes after the result.

      For simple questions answer directly without agents. For content requests include the
      complete content in your final reply. Do not claim external research, image generation,
      deployments, tests or improvements without actual tools and evidence. Put pr_finalizer
      in a plan only if the user asked for a commit, push or PR, and after required checks.
      Report outcomes, checks and blockers honestly; include a PR URL only if returned.`,
		tools: [...terminalTools, ...createCoordinatorTools()],
		handlers: [messageSentHandler],
	});

	setCoordinatorId(agent.getId());
	return agent;
}
