export type AgentKind =
	| 'user'
	| 'coordinator'
	| 'frontend'
	| 'backend'
	| 'quality'
	| 'pr_finalizer';

export type AgentInfo = {id: string; name: string; kind: AgentKind};

// idle: nothing to do | thinking: model inference | tool: running a tool
// waiting: coordinator is blocked on delegated agents
export type AgentStatus = 'idle' | 'thinking' | 'tool' | 'waiting';

export type CommKind = 'user_message' | 'task' | 'result' | 'reply';

export type TaskResult = {
	status: 'done' | 'blocked';
	summary: string;
	filesChanged: string[];
	checks: string[];
	blockers: string[];
};

export type ServerEvent =
	| {type: 'history'; events: ServerEvent[]}
	| {type: 'agent.joined'; agent: AgentInfo}
	| {type: 'agent.status'; agentId: string; status: AgentStatus; tool?: string; at: number}
	| {type: 'activity'; agentId: string; tone: 'tool' | 'say'; text: string; at: number}
	| {type: 'comm'; fromId: string; toId: string; kind: CommKind; text: string; at: number}
	| {type: 'task.dispatched'; taskId: string; agentId: string; task: string; criteria: string[]; at: number}
	| {type: 'task.result'; taskId: string; agentId: string; result: TaskResult; at: number}
	| {type: 'error'; message: string; at: number};

export type ClientEvent = {type: 'send'; text: string};
