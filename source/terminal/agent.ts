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
import {terminalTools} from './tools.js';
import {
	createDelegationTools,
	parseHelpRequestEnvelope,
	setCoordinatorId,
} from '../agents/task-router.js';

class MessageSentSpecification extends SituationSpecification {
	isSatisfiedBy({event, participant}: SituationContext): boolean {
		return (
			event.type === 'message.sent' && event.producerId !== participant.getId()
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

		runLoop(participant.getId(), prompt, input);
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
		instruction: `You are the user's task coordinator.

      First call list_agent_roles, analyze the user request, and choose the smallest relevant
      set of roles. Catalog entries are descriptions, not running agents. Use delegate_role_task
      for tester, marketing, designer, devops, or any catalog role; the router creates agents only
      when a task is dispatched and reuses free agents. get_agent_availability lists only agents
      already created; an empty roster does not mean a role is unavailable.
      Do not delegate to unrelated roles. For simple questions answer directly without a team.
      Give parallel tasks separate file or responsibility scopes. If capacity is exhausted,
      wait for existing delegated work to finish or report the limit; do not invent agents.

      For a small frontend-only task, call delegate_frontend_task.
      For a large frontend task, split it into independent subtasks and call
      delegate_frontend_tasks. Give every subtask a unique key, use dependsOn for prerequisites,
      and assign parallel tasks separate file or responsibility scopes.
      For a small backend-only task, call delegate_backend_task.
      For a large backend task, split it into independent subtasks and call
      delegate_backend_tasks. Give every subtask a unique key. Use dependsOn to describe
      prerequisites between subtasks; do not start dependent work before its prerequisites
      return status "done". The router schedules ready tasks across the free Backend agents.
      For an independent full-stack task, define one API contract and call
      delegate_frontend_and_backend.
      Do not start Integration while a required implementation task is still blocked. Resolve
      the blocker with a suitable free agent or report clearly that the task cannot proceed.

      When you receive a structured Backend help request, evaluate the remaining work and its
      dependencies. Call get_agent_availability, then use delegate_remaining_backend_task with
      the request ID and requester agent ID so that another free Backend agent receives the
      handoff. Pass the dependency lists from the request unchanged; the router rejects the
      handoff if any prerequisite is unfinished or no other Backend agent is free. Always call
      this tool so the requesting Backend receives either the helper's result or a clear blocked
      result. Do not run Integration or Quality from this help-request response; the original
      task coordinator flow runs those after the requesting Backend reports its final result.

      Choose follow-up steps according to the requested outcome. Use integration only when
      independently implemented pieces need to be connected. For code changes select tester
      or quality for relevant verification; do not claim checks passed unless they actually ran.
      Respect dependencies and fix blockers before downstream work. Marketing-only tasks do not
      need integration, code testing, or a PR. Include the complete marketing copy in your reply.
      Call pr_finalizer only when the user requested a commit, push, or pull request, and only
      after required checks succeed. Report results and blockers honestly. Include a PR URL
      only if pr_finalizer returned one.`,
		tools: [...terminalTools, ...createDelegationTools()],
		handlers: [messageSentHandler],
	});

	setCoordinatorId(agent.getId());
	return agent;
}
