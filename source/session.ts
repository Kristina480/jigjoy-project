import { createHuman, type SemanticEvent } from '@mozaik-ai/core';

import {
  EnvironmentState,
  initializeRuntime,
  join,
  sendMessage,
} from './runtime.js';

import { createTerminalAgent } from './terminal/agent.js';
import { createUIUpdater } from './ui-updater.js';
import { createRoleAgent } from './agents/role-agent.js';
import { resetTaskRouter } from './agents/task-router.js';
import { createRuntimeObserver } from './runtime-observer.js';


export const DEFAULT_BACKEND_AGENT_COUNT = 2;
export const DEFAULT_FRONTEND_AGENT_COUNT = 2;
const MAX_AGENT_POOL_SIZE = 8;
const JIGJOY_BACKEND_AGENT_COUNT=2;
const JIGJOY_FRONTEND_AGENT_COUNT=2;

export type AgentSessionOptions = {
  backendAgentCount?: number;
  frontendAgentCount?: number;
};

export type AgentSession = {
  send: (message: string) => void;
};

export type AgentListeners = {
  onAssistantText: (text: string) => void;
  onFunctionCall?: (name: string) => void;
  onRuntimeEvent?: (event: SemanticEvent) => void;
};

initializeRuntime({ state: new EnvironmentState() });

export function createAgentSession(
  listeners: AgentListeners,
  options: AgentSessionOptions = {},
): AgentSession {
  const configuredAgentCount = String(
    JIGJOY_BACKEND_AGENT_COUNT ?? '',
  ).trim();
  const backendAgentCount =
    options.backendAgentCount ??
    (configuredAgentCount.length > 0
      ? Number(configuredAgentCount)
      : DEFAULT_BACKEND_AGENT_COUNT);
  const environmentFrontendCount = JIGJOY_FRONTEND_AGENT_COUNT;
  const configuredFrontendCount = String(environmentFrontendCount ?? '').trim();
  const frontendAgentCount =
    options.frontendAgentCount ??
    (configuredFrontendCount.length > 0
      ? Number(configuredFrontendCount)
      : DEFAULT_FRONTEND_AGENT_COUNT);

  if (
    !Number.isInteger(backendAgentCount) ||
    backendAgentCount < 1 ||
    backendAgentCount > MAX_AGENT_POOL_SIZE
  ) {
    throw new RangeError(
      `backendAgentCount must be an integer between 1 and ${MAX_AGENT_POOL_SIZE}.`,
    );
  }

  if (
    !Number.isInteger(frontendAgentCount) ||
    frontendAgentCount < 1 ||
    frontendAgentCount > MAX_AGENT_POOL_SIZE
  ) {
    throw new RangeError(
      `frontendAgentCount must be an integer between 1 and ${MAX_AGENT_POOL_SIZE}.`,
    );
  }

  resetTaskRouter();
  const coordinator = createTerminalAgent();

  const frontendAgents = Array.from(
    { length: frontendAgentCount },
    (_, index) => createRoleAgent('frontend', `Frontend Agent ${index + 1}`),
  );
  const backendAgents = Array.from({ length: backendAgentCount }, (_, index) =>
    createRoleAgent('backend', `Backend Agent ${index + 1}`),
  );
  const integrationAgent = createRoleAgent('integration');
  const qualityAgent = createRoleAgent('quality');
  const prFinalizerAgent = createRoleAgent('pr_finalizer');

  const uiUpdater = createUIUpdater(listeners);

  const user = createHuman({
    name: 'User',
    capabilities: [],
    handlers: [],
  });


  // Joined first so it also sees every participant.joined event.
  if (listeners.onRuntimeEvent) {
    join(createRuntimeObserver(listeners.onRuntimeEvent));
  }


  join(user);
  join(coordinator);
  for (const frontendAgent of frontendAgents) {
    join(frontendAgent);
  }
  for (const backendAgent of backendAgents) {
    join(backendAgent);
  }
  join(integrationAgent);
  join(qualityAgent);
  join(prFinalizerAgent);
  join(uiUpdater);

  return {
    send: (message: string) => sendMessage(message, user.getId()),
  };
}
