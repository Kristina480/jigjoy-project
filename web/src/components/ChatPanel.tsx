import {type KeyboardEvent, useEffect, useRef, useState} from 'react';
import type {ConnectionStatus} from '../hooks/useAgentSocket';
import type {ChatMessage} from '../state/store';
import MessageRow from './MessageRow';

type Props = {
	messages: ChatMessage[];
	status: ConnectionStatus;
	working: boolean;
	onSend: (text: string) => void;
};

export default function ChatPanel({messages, status, working, onSend}: Props) {
	const [input, setInput] = useState('');
	const endRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		endRef.current?.scrollIntoView({behavior: 'smooth'});
	}, [messages, working]);

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
					<div className="hero">
						<h2>What should we build?</h2>
						<p>The coordinator hands work to specialist agents. You can watch each one here.</p>
					</div>
				)}
				{messages.map(message => (
					<MessageRow key={message.id} message={message} />
				))}
				{working && (
					<div className="typing" aria-label="Coordinator is working">
						<i />
						<i />
						<i />
					</div>
				)}
				<div ref={endRef} />
			</div>

			<div className="composer">
				<div className="composer-box">
					<textarea
						value={input}
						onChange={event => setInput(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder={status === 'open' ? 'Message' : 'Connecting…'}
						rows={1}
						disabled={status !== 'open'}
					/>
					<button className="send" onClick={submit} disabled={status !== 'open' || !input.trim()} aria-label="Send">
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M7 12V2M2.5 6.5 7 2l4.5 4.5" />
						</svg>
					</button>
				</div>
			</div>
		</section>
	);
}
