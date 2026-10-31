import {roleCatalog, type AgentRole} from '../source/agents/role-catalog.js';
import type {SemanticEvent} from '@mozaik-ai/core';
import type {
	AgentInfo,
	AgentKind,
	ServerEvent,
	TaskResult,
} from '../shared/events.js';
import {parseTaskEnvelope} from '../source/agents/task-router.js';

export function kindFromName(name: string): AgentKind | undefined {
	const normalized = name.toLowerCase();
	if (normalized === 'user') return 'user';
	if (normalized === 'terminal agent / coordinator') return 'coordinator';
	for (const [role, config] of Object.entries(roleCatalog)) {
		const base = config.name.toLowerCase();
		if (
			normalized === base ||
			(normalized.startsWith(`${base} `) &&
				/^\d+$/.test(normalized.slice(base.length + 1)))
		) {
			return role as AgentRole;
		}
	}
	return undefined;
}

function parseArgs(args: string): Record<string, unknown> {
	try {
		const value = JSON.parse(args) as unknown;
		return typeof value === 'object' && value
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

// Turns raw Mozaik runtime events into the small event set the UI understands.
export function createTranslator(emit: (event: ServerEvent) => void) {
	const agents = new Map<string, AgentInfo>();
	const activeTools = new Map<string, Map<string, string>>();
	const activeTasks = new Map<string, string>();
	function toolStatus(
		agentId: string,
		fallback: 'thinking' | 'idle',
		at: number,
	) {
		const tools = [...(activeTools.get(agentId)?.values() ?? [])];
		const waiting = tools.some(
			name => name.startsWith('delegate_') || name === 'request_task_help',
		);
		emit({
			type: 'agent.status',
			agentId,
			status: waiting ? 'waiting' : tools.length > 0 ? 'tool' : fallback,
			...(tools.length > 0 ? {tool: tools[0]} : {}),
			at,
		});
	}
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

			case 'participant.left': {
				const {id} = event.payload as {id: string};
				if (!agents.has(id)) return;
				agents.delete(id);
				activeTools.delete(id);
				activeTasks.delete(id);
				emit({type: 'agent.left', agentId: id});
				return;
			}

			case 'message.sent': {
				const {message} = event.payload as {message: string};
				const coordinator = byKind('coordinator');

				if (producer?.kind === 'user' && coordinator) {
					emit({
						type: 'comm',
						fromId: producer.id,
						toId: coordinator.id,
						kind: 'user_message',
						text: message,
						at,
					});
				} else if (producer?.kind === 'coordinator') {
					const task = parseTaskEnvelope(message);
					const assignee = task && agents.get(task.targetAgentId);
					if (task && assignee) {
						activeTasks.set(assignee.id, task.taskId);
						emit({
							type: 'agent.status',
							agentId: assignee.id,
							status: 'thinking',
							at,
						});
						emit({
							type: 'task.dispatched',
							taskId: task.taskId,
							agentId: assignee.id,
							task: task.task,
							criteria: task.acceptanceCriteria,
							at,
						});
						emit({
							type: 'comm',
							fromId: producer.id,
							toId: assignee.id,
							kind: 'task',
							text: task.task,
							at,
						});
					}
				}

				return;
			}

			case 'message_received.started':
			case 'inference.started': {
				if (producer) toolStatus(producer.id, 'thinking', at);
				return;
			}
			case 'function_call.completed': {
				if (!producer) return;
				const {callId} = event.payload as {callId: string};
				const tools = activeTools.get(producer.id);
				const name = tools?.get(callId);
				tools?.delete(callId);
				toolStatus(
					producer.id,
					name === 'submit_task_result' && !activeTasks.has(producer.id)
						? 'idle'
						: 'thinking',
					at,
				);
				return;
			}
			case 'agent.run.completed': {
				if (producer)
					toolStatus(
						producer.id,
						activeTasks.has(producer.id) ? 'thinking' : 'idle',
						at,
					);
				return;
			}
			case 'agent.run.failed': {
				if (!producer) return;
				activeTools.delete(producer.id);
				emit({type: 'agent.status', agentId: producer.id, status: 'idle', at});
				const {message} = event.payload as {message: string};
				emit({type: 'error', agentId: producer.id, message, at});
				return;
			}
			case 'agent.task.result': {
				if (!producer) return;
				const {taskId, result} = event.payload as {
					taskId: string;
					result: TaskResult;
				};
				if (activeTasks.get(producer.id) !== taskId) return;
				activeTasks.delete(producer.id);
				emit({type: 'task.result', taskId, agentId: producer.id, result, at});
				emit({type: 'agent.status', agentId: producer.id, status: 'idle', at});
				const coordinator = byKind('coordinator');
				if (coordinator)
					emit({
						type: 'comm',
						fromId: producer.id,
						toId: coordinator.id,
						kind: 'result',
						text: `[${result.status}] ${result.summary}`,
						at,
					});
				emit({
					type: 'activity',
					agentId: producer.id,
					tone: 'tool',
					text: 'submitted task result',
					at,
				});
				return;
			}

			case 'function_call.started': {
				if (!producer) return;
				const {call} = event.payload as {
					call: {callId: string; name: string; args: string};
				};
				const tools = activeTools.get(producer.id) ?? new Map<string, string>();
				tools.set(call.callId, call.name);
				activeTools.set(producer.id, tools);
				const args = parseArgs(call.args);

				if (call.name.startsWith('delegate_')) {
					emit({
						type: 'agent.status',
						agentId: producer.id,
						status: 'waiting',
						at,
					});
					emit({
						type: 'activity',
						agentId: producer.id,
						tone: 'tool',
						text: `delegating (${call.name.replace('delegate_', '')})`,
						at,
					});
					return;
				}

				emit({
					type: 'agent.status',
					agentId: producer.id,
					status: 'tool',
					tool: call.name,
					at,
				});

				if (call.name === 'submit_task_result') return;

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
				toolStatus(
					producer.id,
					activeTasks.has(producer.id) ? 'thinking' : 'idle',
					at,
				);
				if (!text) return;

				const user = byKind('user');
				if (producer.kind === 'coordinator' && user) {
					emit({
						type: 'comm',
						fromId: producer.id,
						toId: user.id,
						kind: 'reply',
						text,
						at,
					});
				} else {
					emit({type: 'activity', agentId: producer.id, tone: 'say', text, at});
				}

				return;
			}

			default:
		}
	};
}
