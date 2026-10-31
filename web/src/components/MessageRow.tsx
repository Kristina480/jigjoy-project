import type {ChatMessage} from '../state/store';

export default function MessageRow({message}: {message: ChatMessage}) {
	if (message.role === 'error') return <div className="row row-error">{message.content}</div>;

	return (
		<div className={`row ${message.role === 'user' ? 'row-user' : 'row-assistant'}`}>
			<div className="bubble">{message.content}</div>
		</div>
	);
}
