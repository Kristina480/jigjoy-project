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
  createRequestTaskHelpTool,
  createSubmitTaskResultTool,
  getCoordinatorId,
  parseTaskEnvelope,
  registerAgent,
  type AgentRole,
} from './task-router.js';

const roleConfig: Record<AgentRole, { name: string; instruction: string }> = {
  frontend: {
    name: 'Frontend Agent',
    instruction:
      'Implement only the assigned frontend task. Follow the API contract. Report changed files, checks, and blockers.',
  },
  backend: {
    name: 'Backend Agent',
    instruction: `Implement only the assigned backend task and follow the API contract.
      Before starting, estimate whether the work is likely to take more than 10 minutes.
      If it is, or you become blocked later, identify a self-contained part another Backend
      agent can do independently and call request_task_help with the current task ID, remaining
      work, its dependencies, and which dependencies are complete. Do not duplicate the helper's
      assigned files or subtasks. The tool returns the helper's result or a blocked reason;
      if the result is blocked, continue the remaining work yourself when possible or report
      the blocker. Use the helper's result before reporting your files, checks, and blockers
      with submit_task_result.
      Do not say help was assigned unless the tool returns a successful result.`,
  },
  integration: {
    name: 'Integration Agent',
    instruction: `Integrate the completed work from the other agents into one coherent solution.
      Inspect the current diff and each agent's task and result. Resolve conflicts, connect the
      pieces, and fix integration issues without expanding scope. Do not claim that integration
      is complete if required work or dependencies are still blocked. Report changed files,
      checks, and blockers with submit_task_result.`,
  },
  quality: {
    name: 'Quality Agent',
    instruction: `You verify and review the completed change.
      First inspect the diff against the task and acceptance criteria. Then run relevant tests,
      type checks, and build commands. Do not edit source files. Return status "blocked" if a
      required check fails or you find a serious issue. In checks, report test/build results and
      review findings separately. Call submit_task_result when finished.`,
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
    const task = parseTaskEnvelope(message);
    return task?.role === this.role && task.targetAgentId === participant.getId();
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
      ...task.acceptanceCriteria.map((item) => `- ${item}`),
      'Dependencies:',
      ...(task.dependencies.length > 0
        ? task.dependencies.map((item) => `- ${item}`)
        : ['- None']),
      'Completed dependencies:',
      ...(task.completedDependencies.length > 0
        ? task.completedDependencies.map((item) => `- ${item}`)
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
  const config = roleConfig[role];
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
      ...terminalTools,
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
