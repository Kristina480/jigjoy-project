import type {AgentInfo, AgentStatus, CommKind, ServerEvent, TaskResult} from '../../../shared/events.js';

export type TaskView = {
	taskId: string;
	task: string;
	criteria: string[];
	status: 'running' | 'done' | 'blocked';
	result?: TaskResult;
	at: number;
};
export type ActivityItem = {text: string; tone: 'tool' | 'say'; at: number};
export type AgentView = {
	info: AgentInfo;
  retired?: boolean;
	status: AgentStatus;
	tool?: string;
	tasks: TaskView[];
	activity: ActivityItem[];
};
export type CommView = {id: number; fromId: string; toId: string; kind: CommKind; text: string; at: number};
export type ChatMessage = {id: number; role: 'user' | 'assistant' | 'error'; content: string};

export type State = {
	agents: Record<string, AgentView>;
	comms: CommView[];
	chat: ChatMessage[];
	nextId: number;
};

export const initialState: State = {agents: {}, comms: [], chat: [], nextId: 0};

function patchAgent(state: State, id: string, patch: (agent: AgentView) => AgentView): State {
	const agent = state.agents[id];
	return agent ? {...state, agents: {...state.agents, [id]: patch(agent)}} : state;
}

export function reduce(state: State, event: ServerEvent): State {
	switch (event.type) {
		case 'history':
			return event.events.reduce(reduce, initialState);

		case 'agent.joined':
			return {
				...state,
				agents: {...state.agents, [event.agent.id]: {info: event.agent, status: 'idle', tasks: [], activity: []}},
			};

    case 'agent.left':
      return patchAgent(state, event.agentId, agent => ({...agent, retired: true, status: 'idle', tool: undefined}));

		case 'agent.status':
			return patchAgent(state, event.agentId, agent => ({
				...agent,
				status: event.status === 'idle' && agent.tasks.some(task => task.status === 'running') ? 'thinking' : event.status,
				tool: event.status === 'tool' ? event.tool : undefined,
			}));

		case 'activity':
			return patchAgent(state, event.agentId, agent => ({
				...agent,
				activity: [...agent.activity, {text: event.text, tone: event.tone, at: event.at}].slice(-30),
			}));

		case 'task.dispatched':
			return patchAgent(state, event.agentId, agent => ({
				...agent,
        status: 'thinking',
        tool: undefined,
				tasks: [
					...agent.tasks,
					{taskId: event.taskId, task: event.task, criteria: event.criteria, status: 'running', at: event.at},
				],
			}));

		case 'task.result':
			return patchAgent(state, event.agentId, agent => ({
				...agent,
        status: agent.tasks.some(task => task.taskId !== event.taskId && task.status === 'running') ? agent.status : 'idle',
        tool: undefined,
				tasks: agent.tasks.map(task =>
					task.taskId === event.taskId ? {...task, status: event.result.status, result: event.result} : task,
				),
			}));

		case 'comm': {
			const id = state.nextId;
			const comm: CommView = {id, fromId: event.fromId, toId: event.toId, kind: event.kind, text: event.text, at: event.at};
			const chatRole = event.kind === 'user_message' ? 'user' : event.kind === 'reply' ? 'assistant' : undefined;
			return {
				...state,
				nextId: id + 1,
				comms: [...state.comms, comm].slice(-200),
				chat: chatRole ? [...state.chat, {id, role: chatRole, content: event.text}] : state.chat,
			};
		}

    case 'error': {
      // An agent failure must not erase other agents' live work.
      const next = event.agentId ? patchAgent(state, event.agentId, agent => ({...agent, status: 'idle', tool: undefined})) : state;
      return {...next, nextId: next.nextId + 1,
        chat: [...next.chat, {id: next.nextId, role: 'error', content: event.message}]};
    }

		default:
			return state;
	}
}


export function getTeamActivity(agents: Record<string, AgentView>) {
  const specialists = Object.values(agents).filter(agent => !agent.retired && agent.info.kind !== 'user' && agent.info.kind !== 'coordinator');
  const working = specialists.filter(agent => agent.tasks.some(task => task.status === 'running'));
  return {working: working.length, total: specialists.length};
}
