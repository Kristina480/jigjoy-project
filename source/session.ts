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
import { createRuntimeObserver } from './runtime-observer.js';

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

  // Joined first so it also sees every participant.joined event.
  if (listeners.onRuntimeEvent) {
    join(createRuntimeObserver(listeners.onRuntimeEvent));
  }

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