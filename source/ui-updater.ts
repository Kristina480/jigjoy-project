import {
	type FunctionCallItem,
	type ModelMessageItem,
	type SituationContext,
	type SituationHandler,
	type SituationProcessor,
	SituationSpecification,
	createHuman,
} from '@mozaik-ai/core';

export type UIUpdaterListeners = {
	onAssistantText: (text: string) => void;
	onFunctionCall?: (name: string) => void;
};

class FunctionCallStartedSpecification extends SituationSpecification {
	isSatisfiedBy({event}: SituationContext): boolean {
		return event.type === 'function_call.started';
	}
}

class FunctionCallStartedProcessor implements SituationProcessor {
	constructor(private readonly listeners: UIUpdaterListeners) {}

	apply({event}: SituationContext): void {
		const {call} = event.payload as {call: FunctionCallItem};
		this.listeners.onFunctionCall?.(call.name);
	}
}

class ModelAnswerSpecification extends SituationSpecification {
	isSatisfiedBy({event}: SituationContext): boolean {
		return event.type === 'model.answer';
	}
}

class ModelAnswerProcessor implements SituationProcessor {
	constructor(private readonly listeners: UIUpdaterListeners) {}

	apply({event}: SituationContext): void {
		const {answer} = event.payload as {answer: ModelMessageItem};
		const text = answer.content?.text ?? '';
		if (text) {
			this.listeners.onAssistantText(text);
		}
	}
}

export function createUIUpdater(listeners: UIUpdaterListeners) {
	const functionCallStartedHandler: SituationHandler = {
		specification: new FunctionCallStartedSpecification(),
		processor: new FunctionCallStartedProcessor(listeners),
	};

	const modelAnswerHandler: SituationHandler = {
		specification: new ModelAnswerSpecification(),
		processor: new ModelAnswerProcessor(listeners),
	};

	return createHuman({
		name: 'UI Updater',
		capabilities: [],
		handlers: [functionCallStartedHandler, modelAnswerHandler],
	});
}
