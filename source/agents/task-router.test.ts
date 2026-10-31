import test from 'ava';

import {
  getAgentAvailability,
  getFreeAgentCount,
  getUnresolvedDependencies,
  parseHelpRequestEnvelope,
  parseTaskEnvelope,
  registerAgent,
  resetTaskRouter,
} from './task-router.js';

test('parseTaskEnvelope accepts a task targeted to one registered role agent', (t) => {
  const task = {
    kind: 'agent.task',
    taskId: 'task-1',
    role: 'backend',
    targetAgentId: 'backend-2',
    task: 'Implement the data endpoint.',
    acceptanceCriteria: ['The endpoint returns the expected data.'],
    dependencies: ['schema-ready'],
    completedDependencies: ['schema-ready'],
  };

  t.deepEqual(parseTaskEnvelope(JSON.stringify(task)), task);
});

test('parseTaskEnvelope rejects a task without a target agent ID', (t) => {
  const task = {
    kind: 'agent.task',
    taskId: 'task-1',
    role: 'backend',
    task: 'Implement the data endpoint.',
    acceptanceCriteria: [],
    dependencies: [],
    completedDependencies: [],
  };

  t.is(parseTaskEnvelope(JSON.stringify(task)), undefined);
});

test('parseHelpRequestEnvelope accepts a Backend handoff request', (t) => {
  const request = {
    kind: 'agent.help.request',
    requestId: 'help-1',
    taskId: 'task-1',
    role: 'backend',
    requesterAgentId: 'backend-1',
    remainingWork: 'Add the response validation.',
    dependencies: ['schema-ready'],
    completedDependencies: ['schema-ready'],
  };

  t.deepEqual(parseHelpRequestEnvelope(JSON.stringify(request)), request);
});

test('parseHelpRequestEnvelope rejects requests from a non-Backend role', (t) => {
  const request = {
    kind: 'agent.help.request',
    requestId: 'help-1',
    taskId: 'task-1',
    role: 'frontend',
    requesterAgentId: 'frontend-1',
    remainingWork: 'Add the response validation.',
    dependencies: [],
    completedDependencies: [],
  };

  t.is(parseHelpRequestEnvelope(JSON.stringify(request)), undefined);
});

test('getUnresolvedDependencies returns only prerequisites not marked complete', (t) => {
  t.deepEqual(
    getUnresolvedDependencies(
      ['schema-ready', 'data-contract'],
      ['schema-ready'],
    ),
    ['data-contract'],
  );
});

test.serial('agent availability lists every free Backend instance', (t) => {
  resetTaskRouter();
  registerAgent('backend', 'backend-1');
  registerAgent('backend', 'backend-2');
  registerAgent('frontend', 'frontend-1');
  registerAgent('frontend', 'frontend-2');
  registerAgent('integration', 'integration-1');

  t.is(getFreeAgentCount('backend'), 2);
  t.is(getFreeAgentCount('frontend'), 2);
  t.deepEqual(
    getAgentAvailability().map(({ role, status }) => ({ role, status })),
    [
      { role: 'backend', status: 'free' },
      { role: 'backend', status: 'free' },
      { role: 'frontend', status: 'free' },
      { role: 'frontend', status: 'free' },
      { role: 'integration', status: 'free' },
    ],
  );

  resetTaskRouter();
});