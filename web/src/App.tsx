import ChatPanel from './components/ChatPanel';
import {useAgentSocket} from './hooks/useAgentSocket';

export default function App() {
	const {messages, status, thinking, send} = useAgentSocket();

	return (
		<div className="app">
			<header className="header">
				<h1>JigJoy Agent</h1>
				<span className={`status status-${status}`}>{status}</span>
			</header>
			<ChatPanel
				messages={messages}
				status={status}
				thinking={thinking}
				onSend={send}
			/>
		</div>
	);
}
