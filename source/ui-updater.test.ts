import test from 'ava';
import {SemanticEvent} from '@mozaik-ai/core';
import {setCoordinatorId} from './agents/task-router.js';
import {createUIUpdater} from './ui-updater.js';

test('coordinator failures reach the CLI error callback instead of leaving it waiting silently', t => {
	setCoordinatorId('coordinator');
	const errors: string[] = [],
		messages: string[] = [];
	const observer = createUIUpdater({
		onAssistantText: text => messages.push(text),
		onError: text => errors.push(text),
	});
	const event = SemanticEvent.create('agent.run.failed', 'coordinator', {
		message: 'Provider rejected the request.',
	});
	for (const handler of observer.getHandlers()) {
		const context = {event, participant: observer};
		if (handler.specification.isSatisfiedBy(context))
			handler.processor.apply(context);
	}
	t.deepEqual(errors, ['Provider rejected the request.']);
	t.deepEqual(messages, []);
});
