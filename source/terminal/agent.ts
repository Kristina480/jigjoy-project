import {
  Agent,
  type InferenceInput,
  type SituationContext,
  type SituationHandler,
  type SituationProcessor,
  SituationSpecification,
  createAgent,
} from '@mozaik-ai/core';

import { runLoop } from '../runtime.js';
import { terminalTools } from './tools.js';
import {
  createDelegationTools,
  setCoordinatorId,
} from '../agents/task-router.js';

class MessageSentSpecification extends SituationSpecification {
  isSatisfiedBy({ event, participant }: SituationContext): boolean {
    return (
      event.type === 'message.sent' &&
      event.producerId !== participant.getId()
    );
  }
}

class InferenceProcessor implements SituationProcessor {
  apply({ event, participant }: SituationContext): void {
    if (!(participant instanceof Agent)) {
      return;
    }

    const { message } = event.payload as { message: string };

    const input: InferenceInput = {
      model: 'gpt-5.4',
      context: participant.getMemory().getContext(),
      tools: participant.getTools(),
    };

    runLoop(participant.getId(), message, input);
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
    instruction: `
		You are the user's task coordinator.

		For a frontend-only task, call delegate_frontend_task.
		For a backend-only task, call delegate_backend_task.
		For an independent full-stack task, define the API contract and call
		delegate_frontend_and_backend.

		After implementation:
		1. Call delegate_quality_task to review the diff and run checks.
		2. If Quality returns status "blocked" or any blockers, do not create a PR.
		Send the required fix to the frontend or backend agent, then run Quality again.
		3. Only after Quality returns status "done" with no blockers, call
		delegate_pr_finalizer_task to create a feature branch, commit, push, and open a PR.
		4. Report the results and PR URL to the user.

		Do not claim that a PR exists unless the PR Finalizer returns its URL.
		`,
    tools: [...terminalTools, ...createDelegationTools()],
    handlers: [messageSentHandler],
  });

  setCoordinatorId(agent.getId());
  return agent;
}