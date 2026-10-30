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
): AgentSession {
  const coordinator = createTerminalAgent();

  const frontendAgent = createRoleAgent('frontend');
  const backendAgent = createRoleAgent('backend');
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
  join(backendAgent);
  join(qualityAgent);
  join(prFinalizerAgent);
  join(uiUpdater);

  return {
    send: (message: string) => sendMessage(message, user.getId()),
  };
}