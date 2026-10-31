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
  parseHelpRequestEnvelope,
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
    const helpRequest = parseHelpRequestEnvelope(message);
    const prompt = helpRequest
      ? [
          'A Backend agent has requested a handoff. Evaluate and route the remaining work.',
          `Original task ID: ${helpRequest.taskId}`,
          `Request ID: ${helpRequest.requestId}`,
          `Requester agent ID: ${helpRequest.requesterAgentId}`,
          `Remaining work: ${helpRequest.remainingWork}`,
          `Dependencies: ${helpRequest.dependencies.join(', ') || 'None'}`,
          `Completed dependencies: ${helpRequest.completedDependencies.join(', ') || 'None'}`,
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

      Before assigning work, call get_agent_availability and use the returned roster to choose
      only registered agents with a free slot. Give parallel backend tasks separate file or
      responsibility scopes so they do not edit the same work at the same time.

      For a frontend-only task, call delegate_frontend_task.
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

      After all required implementation tasks return status "done", call
      delegate_integration_task. Include the original task, acceptance criteria, each agent's
      result summary and changed files, and any shared API contract. If Integration is blocked,
      send a scoped fix to a free implementation agent and run Integration again. Only after
      Integration returns status "done", call delegate_quality_task to review the integrated
      diff and run relevant checks. If Quality reports blockers, send a scoped fix to the
      responsible implementation agent, run Integration again, and then rerun Quality. Do not
      create a PR while Integration or Quality reports blockers. Only after Quality returns
      status "done" with no blockers, call delegate_pr_finalizer_task to create a feature
      branch, commit, push, and open a PR.

      Report the results and PR URL to the user. Do not claim that a PR exists unless the
      PR Finalizer returns its URL.`,
    tools: [...terminalTools, ...createDelegationTools()],
    handlers: [messageSentHandler],
  });

  setCoordinatorId(agent.getId());
  return agent;
}
