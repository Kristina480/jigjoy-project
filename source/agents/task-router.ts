import type { Tool } from '@mozaik-ai/core';
import { sendMessage } from '../runtime.js';

export type AgentRole =
  | 'frontend'
  | 'backend'
  | 'integration'
  | 'quality'
  | 'pr_finalizer';

export type TaskEnvelope = {
  kind: 'agent.task';
  taskId: string;
  role: AgentRole;
  targetAgentId: string;
  task: string;
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

let coordinatorId = '';
let taskCounter = 0;
let helpRequestCounter = 0;

export function setCoordinatorId(id: string): void {
  coordinatorId = id;
}

export function getCoordinatorId(): string {
  return coordinatorId;
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
  coordinatorId = '';
}

export function registerAgent(role: AgentRole, id: string): void {
  if (!id) {
    throw new Error('Cannot register an agent without an ID.');
  }

  registeredAgents.set(id, { id, role, busyTaskId: undefined });
}

export type AgentAvailability = {
  agentId: string;
  role: AgentRole;
  status: 'free' | 'busy';
  taskId?: string;
};

export function getAgentAvailability(): AgentAvailability[] {
  return [...registeredAgents.values()].map((agent) => ({
    agentId: agent.id,
    role: agent.role,
    status: agent.busyTaskId ? ('busy' as const) : ('free' as const),
    ...(agent.busyTaskId ? { taskId: agent.busyTaskId } : {}),
  }));
}

export function getUnresolvedDependencies(
  dependencies: string[],
  completedDependencies: string[],
): string[] {
  const completed = new Set(completedDependencies);
  return dependencies.filter((dependency) => !completed.has(dependency));
}

function isAgentRole(value: unknown): value is AgentRole {
  return (
    value === 'frontend' ||
    value === 'backend' ||
    value === 'integration' ||
    value === 'quality' ||
    value === 'pr_finalizer'
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

export function parseTaskEnvelope(
  message: string,
): TaskEnvelope | undefined {
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
      !isStringArray(value.completedDependencies)
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
    (agent) =>
      agent.role === role &&
      !agent.busyTaskId &&
      agent.id !== excludeAgentId,
  );
}

export function getFreeAgentCount(role: AgentRole): number {
  return [...registeredAgents.values()].filter(
    (agent) => agent.role === role && !agent.busyTaskId,
  ).length;
}

async function dispatchTask(
  role: AgentRole,
  task: string,
  acceptanceCriteria: string[],
  dependencies: string[] = [],
  completedDependencies: string[] = [],
  excludeAgentId?: string,
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
      ...unresolvedDependencies.map((dependency) => `Waiting for: ${dependency}`),
    ]);
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
  const resultPromise = new Promise<TaskResult>((resolve) => {
    pendingTasks.set(taskId, { role, agentId: agent.id, resolve });

    timeout = setTimeout(() => {
      const pending = pendingTasks.get(taskId);

      if (!pending) {
        return;
      }

      pendingTasks.delete(taskId);

      if (agent.busyTaskId === taskId) {
        agent.busyTaskId = undefined;
      }

      pending.resolve(
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
    acceptanceCriteria,
    dependencies,
    completedDependencies,
  };

  try {
    sendMessage(JSON.stringify(envelope), coordinatorId);
  } catch (error) {
    const pending = pendingTasks.get(taskId);

    if (pending) {
      pendingTasks.delete(taskId);
      agent.busyTaskId = undefined;
      pending.resolve(
        blockedResult('The task could not be sent to its assigned agent.', [
          error instanceof Error ? error.message : String(error),
        ]),
      );
    }
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
          items: { type: 'string' },
          description: 'Conditions that must be met.',
        },
        dependencies: {
          type: 'array',
          items: { type: 'string' },
          description: 'Prerequisites for this task.',
        },
        completedDependencies: {
          type: 'array',
          items: { type: 'string' },
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
        taskId: { type: 'string' },
        remainingWork: { type: 'string' },
        dependencies: {
          type: 'array',
          items: { type: 'string' },
        },
        completedDependencies: {
          type: 'array',
          items: { type: 'string' },
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
      const resultPromise = new Promise<TaskResult>((resolve) => {
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
              `No handoff decision was received within ${HELP_REQUEST_TIMEOUT_MS / 60000} minutes.`,
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
        return JSON.stringify({ requestId: request.requestId, result });
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
        frontendTask: { type: 'string' },
        backendTask: { type: 'string' },
        apiContract: { type: 'string' },
        acceptanceCriteria: {
          type: 'array',
          items: { type: 'string' },
        },
        dependencies: {
          type: 'array',
          items: { type: 'string' },
        },
        completedDependencies: {
          type: 'array',
          items: { type: 'string' },
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

      return JSON.stringify({ frontend, backend });
    },
  };
}

type BackendPlanTask = {
  key: string;
  task: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
};

function createBackendPlanTool(): Tool {
  return {
    name: 'delegate_backend_tasks',
    description:
      'Split backend work into independent tasks and run them on free backend agents. Use dependsOn keys to describe ordering.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              task: { type: 'string' },
              acceptanceCriteria: {
                type: 'array',
                items: { type: 'string' },
              },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['key', 'task', 'acceptanceCriteria', 'dependsOn'],
          },
        },
        completedDependencies: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['tasks', 'completedDependencies'],
    },
    strict: true,
    type: 'function',
    invoke: async (args: {
      tasks: BackendPlanTask[];
      completedDependencies: string[];
    }) => {
      if (args.tasks.length === 0) {
        return JSON.stringify(
          blockedResult('No backend tasks were provided.', [
            'Add at least one task to the backend plan.',
          ]),
        );
      }

      const taskKeys = new Set(args.tasks.map((task) => task.key));

      if (taskKeys.size !== args.tasks.length) {
        return JSON.stringify(
          blockedResult('Backend task keys must be unique.', [
            'Give every backend task a different key.',
          ]),
        );
      }

      const completedKeys = new Set(
        args.completedDependencies.filter((key) => !taskKeys.has(key)),
      );
      const unknownDependencies = args.tasks.flatMap((task) =>
        task.dependsOn.filter(
          (dependency) =>
            !taskKeys.has(dependency) && !completedKeys.has(dependency),
        ),
      );

      if (unknownDependencies.length > 0) {
        const uniqueUnknownDependencies = [...new Set(unknownDependencies)];
        return JSON.stringify(
          blockedResult('The backend plan has unknown dependencies.', [
            ...uniqueUnknownDependencies.map(
              (dependency) => `Unknown dependency: ${dependency}`,
            ),
          ]),
        );
      }

      const waiting = new Map<string, BackendPlanTask>();

      for (const task of args.tasks) {
        waiting.set(task.key, task);
      }
      const running = new Map<string, Promise<TaskResult>>();
      const results: Record<string, TaskResult> = {};

      while (waiting.size > 0 || running.size > 0) {
        const readyTasks = [...waiting.values()].filter((task) =>
          task.dependsOn.every((dependency) => completedKeys.has(dependency)),
        );
        const slots = getFreeAgentCount('backend');

        for (const task of readyTasks.slice(0, slots)) {
          waiting.delete(task.key);
          running.set(
            task.key,
            dispatchTask(
              'backend',
              task.task,
              task.acceptanceCriteria,
              task.dependsOn,
              [...completedKeys],
            ),
          );
        }

        if (running.size === 0) {
          for (const task of waiting.values()) {
            const unmet = task.dependsOn.filter(
              (dependency) => !completedKeys.has(dependency),
            );
            results[task.key] = blockedResult(
              `Backend task "${task.key}" could not start.`,
              unmet.length > 0
                ? unmet.map((dependency) => `Dependency not complete: ${dependency}`)
                : ['No free backend agent is available.'],
            );
          }

          break;
        }

        const finished = await Promise.race(
          [...running.entries()].map(async ([key, promise]) => ({
            key,
            result: await promise,
          })),
        );
        running.delete(finished.key);
        results[finished.key] = finished.result;

        if (finished.result.status === 'done') {
          completedKeys.add(finished.key);
        }
      }

      const status = Object.values(results).every(
        (result) => result.status === 'done',
      )
        ? 'done'
        : 'blocked';

      return JSON.stringify({ status, results });
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
        requestId: { type: 'string' },
        requesterAgentId: { type: 'string' },
        task: { type: 'string' },
        acceptanceCriteria: {
          type: 'array',
          items: { type: 'string' },
        },
        dependencies: {
          type: 'array',
          items: { type: 'string' },
        },
        completedDependencies: {
          type: 'array',
          items: { type: 'string' },
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
    createAgentAvailabilityTool(),
    createDelegateTool('frontend'),
    createDelegateTool('backend'),
    createDelegateTool('integration'),
    createDelegateTool('quality'),
    createDelegateTool('pr_finalizer'),
    createBackendPlanTool(),
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
        taskId: { type: 'string' },
        status: { type: 'string' },
        summary: { type: 'string' },
        filesChanged: {
          type: 'array',
          items: { type: 'string' },
        },
        checks: {
          type: 'array',
          items: { type: 'string' },
        },
        blockers: {
          type: 'array',
          items: { type: 'string' },
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
    invoke: async (args: TaskResult & { taskId: string }) => {
      const pending = pendingTasks.get(args.taskId);
      const agentId = getAgentId();

      if (
        !pending ||
        pending.role !== role ||
        pending.agentId !== agentId
      ) {
        return 'No matching task was waiting for this result.';
      }

      pendingTasks.delete(args.taskId);

      pending.resolve({
        status: args.status,
        summary: args.summary,
        filesChanged: args.filesChanged,
        checks: args.checks,
        blockers: args.blockers,
      });

      return 'Result delivered to the coordinator.';
    },
  };
}
