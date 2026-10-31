import {
	type SemanticEvent,
	type SituationContext,
	type SituationHandler,
	SituationSpecification,
	createHuman,
} from '@mozaik-ai/core';

class AnyEventSpecification extends SituationSpecification {
	isSatisfiedBy(_context: SituationContext): boolean {
		return true;
	}
}

// A passive participant that sees every runtime event (from every agent).
export function createRuntimeObserver(
	onEvent: (event: SemanticEvent) => void,
) {
	const handler: SituationHandler = {
		specification: new AnyEventSpecification(),
		processor: {
			apply({event}: SituationContext) {
				try {
					onEvent(event);
				} catch (error) {
					console.error('[observer] handler failed:', error);
				}
			},
		},
	};

	return createHuman({
		name: 'Runtime Observer',
		capabilities: [],
		handlers: [handler],
	});
}
