import {ROLE_META} from '../../../shared/agent-metadata';
import type {AgentKind, AgentStatus} from '../../../shared/events';

export const KIND_META: Record<AgentKind, {label: string; color: string; order: number}> = {
  ...ROLE_META,
  coordinator: {label: 'Coordinator', color: '#a855f7', order: 0},
  user: {label: 'You', color: '#8a92a6', order: 51},
};

export function statusLabel(status: AgentStatus, tool?: string): string {
	switch (status) {
		case 'thinking':
			return 'thinking…';
		case 'tool':
			return `running ${tool ?? 'tool'}`;
		case 'waiting':
			return 'waiting for agents';
		default:
			return 'idle';
	}
}

export const formatTime = (at: number) =>
	new Date(at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
