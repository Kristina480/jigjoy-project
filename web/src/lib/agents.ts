import type {AgentKind, AgentStatus} from '../../../shared/events';

export const KIND_META: Record<AgentKind, {label: string; color: string; order: number}> = {
	coordinator: {label: 'Coordinator', color: '#a855f7', order: 0},
	frontend: {label: 'Frontend', color: '#3b82f6', order: 1},
	backend: {label: 'Backend', color: '#22c55e', order: 2},
	quality: {label: 'Quality', color: '#eab308', order: 3},
	pr_finalizer: {label: 'PR Finalizer', color: '#ec4899', order: 4},
	user: {label: 'You', color: '#8a92a6', order: 5},
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
