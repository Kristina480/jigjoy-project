import type { Tool } from '@mozaik-ai/core';
import { sendMessage } from '../runtime.js';

export type AgentRole =
  | 'frontend'
  | 'backend'
  | 'quality'
  | 'pr_finalizer';

export type TaskEnvelope = {
  kind: 'agent.task';
  taskId: string;
  role: AgentRole;
  task: string;
  acceptanceCriteria: string[];
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
  resolve: (result: TaskResult) => void;
  reject: (error: Error) => void;
};

const pendingTasks = new Map<string, PendingTask>();
const RESULT_TIMEOUT_MS = 10 * 60 * 1000;

let coordinatorId = '';
let taskCounter = 0;

export function setCoordinatorId(id: string): void {
  coordinatorId = id;
}

export function getCoordinatorId(): string {
  return coordinatorId;
}

export function parseTaskEnvelope(
  message: string,
): TaskEnvelope | undefined {
  try {
    const value = JSON.parse(message) as Partial<TaskEnvelope>;

    if (
      value.kind !== 'agent.task' ||
      typeof value.taskId !== 'string' ||
      typeof value.role !== 'string' ||
      typeof value.task !== 'string' ||
      !Array.isArray(value.acceptanceCriteria)
    ) {
      return undefined;
    }

    return value as TaskEnvelope;
  } catch {
    return undefined;
  }
}

async function dispatchTask(
  role: AgentRole,
  task: string,
  acceptanceCriteria: string[],
): Promise<TaskResult> {
  if (!coordinatorId) {
    throw new Error('Coordinator has not been created.');
  }

  const taskId = `${Date.now()}-${++taskCounter}`;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const resultPromise = new Promise<TaskResult>((resolve, reject) => {
    pendingTasks.set(taskId, { role, resolve, reject });

    timeout = setTimeout(() => {
      pendingTasks.delete(taskId);
      reject(new Error(`${role} agent timed out.`));
    }, RESULT_TIMEOUT_MS);
  });

  const envelope: TaskEnvelope = {
    kind: 'agent.task',
    taskId,
    role,
    task,
    acceptanceCriteria,
  };

  try {
    sendMessage(JSON.stringify(envelope), coordinatorId);
    return await resultPromise;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
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
      },
      required: ['task', 'acceptanceCriteria'],
    },
    strict: true,
    type: 'function',
    invoke: async (args: {
      task: string;
      acceptanceCriteria: string[];
    }) => {
      const result = await dispatchTask(
        role,
        args.task,
        args.acceptanceCriteria,
      );

      return JSON.stringify(result);
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
      },
      required: [
        'frontendTask',
        'backendTask',
        'apiContract',
        'acceptanceCriteria',
      ],
    },
    strict: true,
    type: 'function',
    invoke: async (args: {
      frontendTask: string;
      backendTask: string;
      apiContract: string;
      acceptanceCriteria: string[];
    }) => {
      const [frontend, backend] = await Promise.all([
        dispatchTask(
          'frontend',
          `${args.frontendTask}\n\nAPI contract:\n${args.apiContract}`,
          args.acceptanceCriteria,
        ),
        dispatchTask(
          'backend',
          `${args.backendTask}\n\nAPI contract:\n${args.apiContract}`,
          args.acceptanceCriteria,
        ),
      ]);

      return JSON.stringify({ frontend, backend });
    },
  };
}

export function createDelegationTools(): Tool[] {
  return [
    createDelegateTool('frontend'),
    createDelegateTool('backend'),
    createDelegateTool('quality'),
    createDelegateTool('pr_finalizer'),
    createFullStackTool(),
  ];
}

export function createSubmitTaskResultTool(role: AgentRole): Tool {
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

      if (!pending || pending.role !== role) {
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