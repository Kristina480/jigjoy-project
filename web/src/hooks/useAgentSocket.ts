import {useCallback, useEffect, useRef, useState} from 'react';
import type {ClientEvent, ServerEvent} from '../../../shared/events';

export type ChatMessage = {
	id: number;
	role: 'user' | 'assistant' | 'tool' | 'error';
	content: string;
};

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export function useAgentSocket() {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [status, setStatus] = useState<ConnectionStatus>('connecting');
	const [thinking, setThinking] = useState(false);
	const socketRef = useRef<WebSocket | null>(null);
	const nextId = useRef(0);

	const push = useCallback((role: ChatMessage['role'], content: string) => {
		setMessages(prev => [...prev, {id: nextId.current++, role, content}]);
	}, []);

	useEffect(() => {
		let disposed = false;
		let retryTimer: number | undefined;

		const connect = () => {
			const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
			const socket = new WebSocket(`${protocol}://${location.host}/ws`);
			socketRef.current = socket;
			setStatus('connecting');

			socket.onopen = () => setStatus('open');

			socket.onmessage = event => {
				const data = JSON.parse(event.data as string) as ServerEvent;
				switch (data.type) {
					case 'assistant':
						setThinking(false);
						push('assistant', data.text);
						break;
					case 'tool':
						push('tool', `calling tool: ${data.name}`);
						break;
					case 'error':
						setThinking(false);
						push('error', data.message);
						break;
					default:
						break;
				}
			};

			socket.onclose = () => {
				setStatus('closed');
				setThinking(false);
				if (!disposed) retryTimer = window.setTimeout(connect, 1500);
			};
		};

		connect();

		return () => {
			disposed = true;
			window.clearTimeout(retryTimer);
			socketRef.current?.close();
		};
	}, [push]);

	const send = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			const socket = socketRef.current;
			if (!trimmed || !socket || socket.readyState !== WebSocket.OPEN) return;

			push('user', trimmed);
			setThinking(true);
			const payload: ClientEvent = {type: 'send', text: trimmed};
			socket.send(JSON.stringify(payload));
		},
		[push],
	);

	return {messages, status, thinking, send};
}
