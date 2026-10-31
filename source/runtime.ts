import {createConcurrentRunLoop} from './concurrent-loop.js';
import {defineRuntime, RuntimeState} from '@mozaik-ai/core';

export class EnvironmentState extends RuntimeState {}

export const {
	initializeRuntime,
	resolveRuntime,
	resolveParticipant,
	join,
	leave,
	sendMessage,
	sendEvent,
} = defineRuntime<EnvironmentState>();

export const runLoop = createConcurrentRunLoop(resolveRuntime);
