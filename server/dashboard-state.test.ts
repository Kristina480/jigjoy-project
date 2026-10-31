import test from 'ava';
import {getTeamActivity, initialState, reduce} from '../web/src/state/store.js';
import type {ServerEvent} from '../shared/events.js';

function workingTeam() {
	const events: ServerEvent[] = [
		{
			type: 'agent.joined',
			agent: {id: 'f', name: 'Frontend Agent 1', kind: 'frontend'},
		},
		{
			type: 'agent.joined',
			agent: {id: 'b', name: 'Backend Agent 1', kind: 'backend'},
		},
		{
			type: 'task.dispatched',
			agentId: 'f',
			taskId: 'ui',
			task: 'UI',
			criteria: [],
			at: 0,
		},
		{
			type: 'task.dispatched',
			agentId: 'b',
			taskId: 'api',
			task: 'API',
			criteria: [],
			at: 0,
		},
	];
	return events.reduce(reduce, initialState);
}

test('two dispatched specialists both appear working without additional model events', t => {
	const state = workingTeam();
	t.deepEqual(getTeamActivity(state.agents), {working: 2, total: 2});
	t.is(state.agents['f']!.status, 'thinking');
	t.is(state.agents['b']!.status, 'thinking');
});

test('a scoped failure leaves another specialist working', t => {
	let state = reduce(workingTeam(), {
		type: 'error',
		agentId: 'f',
		message: 'Failed UI request',
		at: 1,
	});
	t.is(state.agents['b']!.status, 'thinking');
	state = reduce(state, {
		type: 'task.result',
		agentId: 'f',
		taskId: 'ui',
		result: {
			status: 'blocked',
			summary: 'UI failed',
			filesChanged: [],
			checks: [],
			blockers: ['Provider error'],
		},
		at: 2,
	});
	t.is(getTeamActivity(state.agents).working, 1);
	t.is(state.agents['b']!.tasks[0]!.status, 'running');
});

test('an old idle event cannot hide a newly dispatched task', t => {
	const state = reduce(workingTeam(), {
		type: 'agent.status',
		agentId: 'f',
		status: 'idle',
		at: 1,
	});
	t.is(state.agents['f']!.status, 'thinking');
	t.is(getTeamActivity(state.agents).working, 2);
});

test('retired idle agents leave the active count but keep historical identity for logs', t => {
	const state = reduce(workingTeam(), {type: 'agent.left', agentId: 'f'});
	t.true(state.agents['f']!.retired);
	t.is(state.agents['f']!.info.name, 'Frontend Agent 1');
	t.deepEqual(getTeamActivity(state.agents), {working: 1, total: 1});
});
