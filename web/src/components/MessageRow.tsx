import type {ChatMessage} from '../hooks/useAgentSocket';

export default function MessageRow({message}: {message: ChatMessage}) {
	if (message.role === 'tool') {
		return <div className="row row-tool">· {message.content}</div>;
	}

	if (message.role === 'error') {
		return <div className="row row-error">⚠ {message.content}</div>;
	}

	const isUser = message.role === 'user';

	return (
		<div className={`row ${isUser ? 'row-user' : 'row-assistant'}`}>
			<div className="label">{isUser ? 'You' : 'Agent'}</div>
			<div className="bubble">{message.content}</div>
		</div>
	);
}
