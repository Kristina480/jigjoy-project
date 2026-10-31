import {randomUUID} from 'node:crypto';
import {
	DeveloperMessageItem,
	SystemMessageItem,
	FunctionCallOutputItem,
	ModelContext,
	SemanticEvent,
	UserMessageItem,
	type FunctionCallItem,
	type InferenceInput,
	type InferenceOutput,
	type InferenceRunner,
	type Tool,
} from '@mozaik-ai/core';

type LoopRuntime = {
	publish(event: SemanticEvent): void;
	getInferenceRunner(): InferenceRunner;
	getFunctionCallRunner(): {
		run(call: FunctionCallItem, tool: Tool): Promise<FunctionCallOutputItem>;
	};
};

type LoopOptions = {
	concurrent?: boolean;
	isolated?: boolean;
	onStart?: () => void;
};

// Mozaik 4.0.5's default transition selects only the first function call.
// Keep every call and its ID, run the entire batch, then return every output.
export function createConcurrentRunLoop(resolveRuntime: () => LoopRuntime) {
	const queues = new Map<string, Promise<void>>();
	async function execute(
		agentId: string,
		message: string,
		input: InferenceInput,
		options: LoopOptions,
	) {
		const runtime = resolveRuntime();
		const loopId = randomUUID();
		const publish = (type: string, payload: Record<string, unknown>) =>
			runtime.publish(
				SemanticEvent.create(type, agentId, {...payload, loopId}),
			);
		const request = {
			...input,
			context: options.isolated
				? new ModelContext(
						randomUUID(),
						input.context
							.getItems()
							.filter(
								item =>
									item instanceof DeveloperMessageItem ||
									item instanceof SystemMessageItem,
							),
				  )
				: input.context,
		};
		try {
			options.onStart?.();
			publish('message_received.started', {content: message, input: request});
			request.context.addContextItem(UserMessageItem.create(message));
			publish('message_received.completed', {...request});
			for (let turn = 0; turn < 64; turn++) {
				publish('inference.started', {...request});
				let output: InferenceOutput | undefined;
				if (request.streaming) {
					for await (const event of runtime
						.getInferenceRunner()
						.stream(request)) {
						publish('inference.stream', {event});
						if (event.type === 'inference.output')
							output = event.payload as InferenceOutput;
					}
				} else {
					output = await runtime.getInferenceRunner().run(request);
				}
				if (!output) throw new Error('The model returned no inference output.');
				publish('inference.completed', {...output});
				request.context.addContextItems(output.items);
				const calls = output.items.filter(
					(item): item is FunctionCallItem => item.type === 'function_call',
				);
				if (calls.length === 0) {
					const answer = output.items.find(item => item.type === 'message');
					if (!answer)
						throw new Error(
							'The model returned neither a message nor a tool call.',
						);
					publish('model.answer', {answer});
					publish('agent.run.completed', {});
					return;
				}
				const invoke = async (call: FunctionCallItem) => {
					publish('function_call.started', {call, inferenceInput: request});
					let result: FunctionCallOutputItem;
					try {
						const tool = request.tools?.find(tool => tool.name === call.name);
						result = tool
							? await runtime.getFunctionCallRunner().run(call, tool)
							: FunctionCallOutputItem.create(
									call.callId,
									`Error: unknown tool "${call.name}"`,
							  );
					} catch (error) {
						result = FunctionCallOutputItem.create(
							call.callId,
							`Error: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
					publish('function_call.completed', {...result});
					return result;
				};
				// Result submission must happen after all work in this response completes.
				const outputs = new Map<string, FunctionCallOutputItem>();
				await Promise.all(
					calls
						.filter(call => call.name !== 'submit_task_result')
						.map(async call => {
							outputs.set(call.callId, await invoke(call));
						}),
				);
				for (const call of calls.filter(
					call => call.name === 'submit_task_result',
				)) {
					outputs.set(call.callId, await invoke(call));
				}
				request.context.addContextItems(
					calls.map(call => outputs.get(call.callId)!),
				);
				const acceptedSubmission = calls.some(call => {
					if (call.name !== 'submit_task_result') return false;
					try {
						return (
							(
								JSON.parse(outputs.get(call.callId)!.output.text) as {
									accepted?: boolean;
								}
							).accepted === true
						);
					} catch {
						return false;
					}
				});
				if (acceptedSubmission) {
					publish('agent.run.completed', {});
					return;
				}
			}
			throw new Error(
				'Agent stopped after 64 inference turns without completing.',
			);
		} catch (error) {
			publish('agent.run.failed', {
				message: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}
	return function runLoop(
		agentId: string,
		message: string,
		input: InferenceInput,
		options: LoopOptions = {},
	): Promise<void> {
		if (options.concurrent) return execute(agentId, message, input, options);
		// Serialize turns only for the same agent; different agent IDs have independent queues.
		const previous = queues.get(agentId) ?? Promise.resolve();
		const current = previous
			.catch(() => {})
			.then(async () => execute(agentId, message, input, options));
		queues.set(agentId, current);
		const cleanup = () => {
			if (queues.get(agentId) === current) queues.delete(agentId);
		};
		void current.then(cleanup, cleanup);
		return current;
	};
}
