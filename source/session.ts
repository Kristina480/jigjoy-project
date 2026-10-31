import {createHuman, type SemanticEvent} from '@mozaik-ai/core';

import {
	EnvironmentState,
	initializeRuntime,
	join,
	sendMessage,
} from './runtime.js';

import {createTerminalAgent} from './terminal/agent.js';
import {createUIUpdater} from './ui-updater.js';
import {createRoleAgent} from './agents/role-agent.js';
import {
	configureAgentProvisioning,
	resetTaskRouter,
} from './agents/task-router.js';
import {createRuntimeObserver} from './runtime-observer.js';

export type AgentSessionOptions = {
	/** On-demand per-role limits, retained for callers using the old pool options. */
	backendAgentCount?: number;
	frontendAgentCount?: number;
	maxAgents?: number;
};

export type AgentSession = {
	send: (message: string) => void;
};

export type AgentListeners = {
	onAssistantText: (text: string) => void;
	onFunctionCall?: (name: string) => void;
	onRuntimeEvent?: (event: SemanticEvent) => void;
};

initializeRuntime({state: new EnvironmentState()});

export function createAgentSession(
	listeners: AgentListeners,
	options: AgentSessionOptions = {},
): AgentSession {
	resetTaskRouter();
	configureAgentProvisioning(
		(role, name) => {
			join(createRoleAgent(role, name));
		},
		options.maxAgents ?? 8,
		{
			backend: options.backendAgentCount ?? Math.min(2, options.maxAgents ?? 8),
			frontend:
				options.frontendAgentCount ?? Math.min(2, options.maxAgents ?? 8),
		},
	);
	const coordinator = createTerminalAgent();

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
	join(uiUpdater);

	return {
		send: (message: string) => sendMessage(message, user.getId()),
	};
}
