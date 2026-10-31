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
import { terminalTools } from '../terminal/tools.js';
import {
  createSubmitTaskResultTool,
  getCoordinatorId,
  parseTaskEnvelope,
  type AgentRole,
} from './task-router.js';

const roleConfig: Record<AgentRole,{ name: string; instruction: string }> = {
  frontend: {
    name: 'Frontend Agent',
    instruction:
      'Implement only the assigned frontend task. Follow the API contract. Report changed files, checks, and blockers.',
  },
  backend: {
    name: 'Backend Agent',
    instruction:
      'Implement only the assigned backend task. Follow the API contract. Report changed files, checks, and blockers.',
  },
  quality: {
    name: 'Quality Agent',
    instruction: `You verify and review the completed change.First inspect the diff against the task and acceptance criteria.
      Then run the relevant tests, type checks, and build commands.Do not edit source files.Return status "blocked" if a required check fails or you find a serious issue.
      In checks, report test/build results and review findings separately.Call submit_task_result when finished.`,
  },
  pr_finalizer: {
    name: 'PR Finalizer',
    instruction: `You only finalize completed work on GitHub.
      Inspect git status before acting. Do not edit application source files.
      Do not push directly to the default branch and do not merge the pull request.
      Create a feature branch if needed, commit only files related to this task,
      push that branch, and open a pull request with gh.
      If gh is missing or not authenticated, return status "blocked".
      Report the pull request URL in your summary.
      Call submit_task_result when finished.`,
  },
};

class AssignedTaskSpecification extends SituationSpecification {
  constructor(private readonly role: AgentRole) {
    super();
  }

  isSatisfiedBy({ event, participant }: SituationContext): boolean {
    if (
      event.type !== 'message.sent' ||
      event.producerId !== getCoordinatorId() ||
      event.producerId === participant.getId()
    ) {
      return false;
    }

    const { message } = event.payload as { message: string };
    return parseTaskEnvelope(message)?.role === this.role;
  }
}

class AssignedTaskProcessor implements SituationProcessor {
  constructor(private readonly role: AgentRole) {}

  apply({ event, participant }: SituationContext): void {
    if (!(participant instanceof Agent)) {
      return;
    }

    const { message } = event.payload as { message: string };
    const task = parseTaskEnvelope(message);

    if (!task || task.role !== this.role) {
      return;
    }

    const prompt = [
      `Task ID: ${task.taskId}`,
      `Task: ${task.task}`,
      'Acceptance criteria:',
      ...task.acceptanceCriteria.map((item) => `- ${item}`),
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

export function createRoleAgent(role: AgentRole): Agent {
  const config = roleConfig[role];

  const handler: SituationHandler = {
    specification: new AssignedTaskSpecification(role),
    processor: new AssignedTaskProcessor(role),
  };

  return createAgent({
    name: config.name,
    capabilities: ['inference'],
    instruction: config.instruction,
    tools: [...terminalTools, createSubmitTaskResultTool(role)],
    handlers: [handler],
  });
}