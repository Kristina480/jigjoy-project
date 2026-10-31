import { createHuman } from '@mozaik-ai/core';

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

export const DEFAULT_BACKEND_AGENT_COUNT = 2;
const MAX_BACKEND_AGENT_COUNT = 8;
const JIGJOY_BACKEND_AGENT_COUNT=3;

export type AgentSessionOptions = {
  backendAgentCount?: number;
};

export type AgentSession = {
  send: (message: string) => void;
};

export type AgentListeners = {
  onAssistantText: (text: string) => void;
  onFunctionCall?: (name: string) => void;
};

initializeRuntime({ state: new EnvironmentState() });

export function createAgentSession(
  listeners: AgentListeners,
  options: AgentSessionOptions = {},
): AgentSession {
  const backendAgentCount =
    options.backendAgentCount ?? JIGJOY_BACKEND_AGENT_COUNT;

  if (
    !Number.isInteger(backendAgentCount) ||
    backendAgentCount < 1 ||
    backendAgentCount > MAX_BACKEND_AGENT_COUNT
  ) {
    throw new RangeError(
      `backendAgentCount must be an integer between 1 and ${MAX_BACKEND_AGENT_COUNT}.`,
    );
  }

  resetTaskRouter();
  const coordinator = createTerminalAgent();

  const frontendAgent = createRoleAgent('frontend');
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

  join(user);
  join(coordinator);
  join(frontendAgent);
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
