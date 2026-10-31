import type {SemanticEvent} from '@mozaik-ai/core';
import type {
	AgentInfo,
	AgentKind,
	ServerEvent,
	TaskResult,
} from '../shared/events.js';
import {parseTaskEnvelope} from '../source/agents/task-router.js';

function kindFromName(name: string): AgentKind | undefined {
	const n = name.toLowerCase();
	if (n === 'user') return 'user';
	if (n.includes('coordinator')) return 'coordinator';
	if (n.includes('frontend')) return 'frontend';
	if (n.includes('backend')) return 'backend';
	if (n.includes('quality')) return 'quality';
	if (n.includes('pr finalizer')) return 'pr_finalizer';
	return undefined;
}

function parseArgs(args: string): Record<string, unknown> {
	try {
		const value = JSON.parse(args) as unknown;
		return typeof value === 'object' && value ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.map(String) : [];

// Turns raw Mozaik runtime events into the small event set the UI understands.
export function createTranslator(emit: (event: ServerEvent) => void) {
	const agents = new Map<string, AgentInfo>();
	const byKind = (kind: AgentKind) =>
		[...agents.values()].find(agent => agent.kind === kind);

	return (event: SemanticEvent): void => {
		const at = event.occurredAt?.getTime?.() ?? Date.now();
		const producer = agents.get(event.producerId);

		switch (event.type) {
			case 'participant.joined': {
				const manifest = event.payload as {id: string; name: string};
				const kind = kindFromName(manifest.name);
				if (!kind) return;
				const agent: AgentInfo = {id: manifest.id, name: manifest.name, kind};
				agents.set(agent.id, agent);
				emit({type: 'agent.joined', agent});
				return;
			}

			case 'message.sent': {
				const {message} = event.payload as {message: string};
				const coordinator = byKind('coordinator');

				if (producer?.kind === 'user' && coordinator) {
					emit({type: 'comm', fromId: producer.id, toId: coordinator.id, kind: 'user_message', text: message, at});
				} else if (producer?.kind === 'coordinator') {
					const task = parseTaskEnvelope(message);
					const assignee = task && byKind(task.role);
					if (task && assignee) {
						emit({type: 'task.dispatched', taskId: task.taskId, agentId: assignee.id, task: task.task, criteria: task.acceptanceCriteria, at});
						emit({type: 'comm', fromId: producer.id, toId: assignee.id, kind: 'task', text: task.task, at});
					}
				}

				return;
			}

			case 'message_received.started':
			case 'inference.started':
			case 'function_call.completed': {
				if (producer) emit({type: 'agent.status', agentId: producer.id, status: 'thinking', at});
				return;
			}

			case 'function_call.started': {
				if (!producer) return;
				const {call} = event.payload as {call: {name: string; args: string}};
				const args = parseArgs(call.args);

				if (call.name.startsWith('delegate_')) {
					emit({type: 'agent.status', agentId: producer.id, status: 'waiting', at});
					emit({type: 'activity', agentId: producer.id, tone: 'tool', text: `delegating (${call.name.replace('delegate_', '')})`, at});
					return;
				}

				emit({type: 'agent.status', agentId: producer.id, status: 'tool', tool: call.name, at});

				if (call.name === 'submit_task_result') {
					const result: TaskResult = {
						status: args['status'] === 'blocked' ? 'blocked' : 'done',
						summary: String(args['summary'] ?? ''),
						filesChanged: strings(args['filesChanged']),
						checks: strings(args['checks']),
						blockers: strings(args['blockers']),
					};
					const coordinator = byKind('coordinator');
					emit({type: 'task.result', taskId: String(args['taskId'] ?? ''), agentId: producer.id, result, at});
					if (coordinator) {
						emit({type: 'comm', fromId: producer.id, toId: coordinator.id, kind: 'result', text: `[${result.status}] ${result.summary}`, at});
					}
					emit({type: 'activity', agentId: producer.id, tone: 'tool', text: 'submitted task result', at});
					return;
				}

				const text =
					call.name === 'run_command'
						? `$ ${String(args['command'] ?? '')}`
						: `tool: ${call.name}`;
				emit({type: 'activity', agentId: producer.id, tone: 'tool', text, at});
				return;
			}

			case 'model.answer': {
				if (!producer) return;
				const {answer} = event.payload as {answer: {content?: {text?: string}}};
				const text = answer.content?.text ?? '';
				emit({type: 'agent.status', agentId: producer.id, status: 'idle', at});
				if (!text) return;

				const user = byKind('user');
				if (producer.kind === 'coordinator' && user) {
					emit({type: 'comm', fromId: producer.id, toId: user.id, kind: 'reply', text, at});
				} else {
					emit({type: 'activity', agentId: producer.id, tone: 'say', text, at});
				}

				return;
			}

			default:
		}
	};
}
