import {type KeyboardEvent, useEffect, useRef, useState} from 'react';
import type {ChatMessage, ConnectionStatus} from '../hooks/useAgentSocket';
import MessageRow from './MessageRow';

type Props = {
	messages: ChatMessage[];
	status: ConnectionStatus;
	thinking: boolean;
	onSend: (text: string) => void;
};

export default function ChatPanel({messages, status, thinking, onSend}: Props) {
	const [input, setInput] = useState('');
	const endRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		endRef.current?.scrollIntoView({behavior: 'smooth'});
	}, [messages, thinking]);

	const submit = () => {
		if (!input.trim() || status !== 'open') return;
		onSend(input);
		setInput('');
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<section className="chat">
			<div className="messages">
				{messages.length === 0 && (
					<p className="empty">Ask the coordinator to do something.</p>
				)}
				{messages.map(message => (
					<MessageRow key={message.id} message={message} />
				))}
				{thinking && <div className="thinking">Agent is thinking…</div>}
				<div ref={endRef} />
			</div>

			<div className="composer">
				<textarea
					value={input}
					onChange={event => setInput(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder={
						status === 'open'
							? 'Message the agent… (Enter to send, Shift+Enter for newline)'
							: 'Waiting for server…'
					}
					rows={2}
					disabled={status !== 'open'}
				/>
				<button onClick={submit} disabled={status !== 'open' || !input.trim()}>
					Send
				</button>
			</div>
		</section>
	);
}
