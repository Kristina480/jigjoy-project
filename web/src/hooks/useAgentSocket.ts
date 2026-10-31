import {useCallback, useEffect, useReducer, useRef, useState} from 'react';
import type {ClientEvent, ServerEvent} from '../../../shared/events';
import {initialState, reduce} from '../state/store';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export function useAgentSocket() {
	const [state, dispatch] = useReducer(reduce, initialState);
	const [status, setStatus] = useState<ConnectionStatus>('connecting');
	const socketRef = useRef<WebSocket | null>(null);

	useEffect(() => {
		let disposed = false;
		let retryTimer: number | undefined;

		const connect = () => {
			const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
			const socket = new WebSocket(`${protocol}://${location.host}/ws`);
			socketRef.current = socket;
			setStatus('connecting');

			socket.onopen = () => setStatus('open');
			socket.onmessage = event => dispatch(JSON.parse(event.data as string) as ServerEvent);
			socket.onclose = () => {
				setStatus('closed');
				if (!disposed) retryTimer = window.setTimeout(connect, 1500);
			};
		};

		connect();

		return () => {
			disposed = true;
			window.clearTimeout(retryTimer);
			socketRef.current?.close();
		};
	}, []);

	const send = useCallback((text: string) => {
		const trimmed = text.trim();
		const socket = socketRef.current;
		if (!trimmed || !socket || socket.readyState !== WebSocket.OPEN) return;
		const payload: ClientEvent = {type: 'send', text: trimmed};
		socket.send(JSON.stringify(payload));
	}, []);

	return {state, status, send};
}
