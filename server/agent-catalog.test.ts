import test from 'ava';
import type {SemanticEvent} from '@mozaik-ai/core';
import {
	roleCatalog,
	isAgentRole,
	listAgentRoles,
} from '../source/agents/role-catalog.js';
import {teamRecipes} from '../source/agents/team-recipes.js';
import {ROLE_META} from '../shared/agent-metadata.js';
import type {ServerEvent} from '../shared/events.js';
import {createTranslator, kindFromName} from './translate.js';

test('catalog contains exactly 50 unique, described roles with complete UI metadata', t => {
	const roles = listAgentRoles();
	t.is(roles.length, 50);
	t.is(new Set(roles.map(role => role.name)).size, 50);
	t.deepEqual(
		Object.keys(ROLE_META).sort(),
		roles.map(role => role.role).sort(),
	);
	for (const {role, name, description} of roles) {
		t.true(isAgentRole(role));
		t.true(description.length > 10);
		t.is(kindFromName(name), role);
		t.is(kindFromName(`${name} 2`), role);
	}
	t.false(isAgentRole('__proto__'));
	t.false(isAgentRole('constructor'));
	t.is(kindFromName('Runtime Observer'), undefined);
	t.is(kindFromName('UI Updater'), undefined);
});

test('every suggested team uses real roles and valid, ordered dependencies', t => {
	for (const recipe of teamRecipes) {
		const previous = new Set<string>();
		for (const step of recipe.steps) {
			t.true(isAgentRole(step.role));
			t.false(previous.has(step.key));
			t.true(step.dependsOn.every(key => previous.has(key)));
			previous.add(step.key);
		}
	}
	const design = teamRecipes.find(
		recipe => recipe.name === 'ui_design_implementation',
	)!;
	t.deepEqual(
		design.steps.map(step => step.role),
		['designer', 'frontend', 'frontend', 'tester'],
	);
	t.deepEqual(design.steps[1]!.dependsOn, []);
	t.deepEqual(design.steps[2]!.dependsOn, ['design', 'ui_context']);
	t.is(roleCatalog.marketing.toolAccess, 'none');
});

test('translator targets the correct instance of any dynamically joined role', t => {
	const events: ServerEvent[] = [];
	const translate = createTranslator(event => events.push(event));
	const joined = (id: string, name: string) =>
		translate({
			type: 'participant.joined',
			producerId: id,
			payload: {id, name},
		} as SemanticEvent);
	joined('coordinator', 'Terminal Agent / Coordinator');
	joined('designer-1', 'Designer Agent 1');
	joined('designer-2', 'Designer Agent 2');
	joined('data-1', 'Data Engineer Agent 1');
	translate({
		type: 'message.sent',
		producerId: 'coordinator',
		payload: {
			message: JSON.stringify({
				kind: 'agent.task',
				taskId: 'design-task',
				role: 'designer',
				targetAgentId: 'designer-2',
				task: 'Design UI',
				acceptanceCriteria: [],
				dependencies: [],
				completedDependencies: [],
			}),
		},
	} as SemanticEvent);
	const dispatched = events.find(event => event.type === 'task.dispatched');
	t.is(dispatched?.agentId, 'designer-2');
	t.true(
		events.some(
			event =>
				event.type === 'agent.joined' && event.agent.kind === 'data_engineer',
		),
	);
});

test('a result submission is not shown as complete until the router accepts it', t => {
	const events: ServerEvent[] = [];
	const translate = createTranslator(event => events.push(event));
	for (const [id, name] of [
		['coordinator', 'Terminal Agent / Coordinator'],
		['frontend', 'Frontend Agent 1'],
	]) {
		translate({
			type: 'participant.joined',
			producerId: id!,
			payload: {id, name},
		} as SemanticEvent);
	}
	translate({
		type: 'message.sent',
		producerId: 'coordinator',
		payload: {
			message: JSON.stringify({
				kind: 'agent.task',
				taskId: 'task',
				role: 'frontend',
				targetAgentId: 'frontend',
				task: 'Build UI',
				acceptanceCriteria: [],
				dependencies: [],
				completedDependencies: [],
			}),
		},
	} as SemanticEvent);
	const result = {
		status: 'done',
		summary: 'Complete',
		filesChanged: [],
		checks: [],
		blockers: [],
	};
	translate({
		type: 'function_call.started',
		producerId: 'frontend',
		payload: {
			call: {
				callId: 'submit',
				name: 'submit_task_result',
				args: JSON.stringify({taskId: 'task', ...result}),
			},
		},
	} as SemanticEvent);
	t.false(events.some(event => event.type === 'task.result'));
	translate({
		type: 'agent.task.result',
		producerId: 'frontend',
		payload: {taskId: 'wrong', result},
	} as SemanticEvent);
	t.false(events.some(event => event.type === 'task.result'));
	translate({
		type: 'agent.task.result',
		producerId: 'frontend',
		payload: {taskId: 'task', result},
	} as SemanticEvent);
	t.is(events.filter(event => event.type === 'task.result').length, 1);
});
