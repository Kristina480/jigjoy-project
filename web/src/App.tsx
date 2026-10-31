import AgentsPanel from './components/AgentsPanel';
import ChatPanel from './components/ChatPanel';
import {useAgentSocket} from './hooks/useAgentSocket';

export default function App() {
	const {state, status, send} = useAgentSocket();
	const started = state.chat.length > 0;
	const coordinator = Object.values(state.agents).find(agent => agent.info.kind === 'coordinator');
	const working = !!coordinator && coordinator.status !== 'idle';

	return (
		<div className={`app ${started ? 'started' : ''}`}>
			<header className="header">
				<h1>JigJoy Agent</h1>
				<span className={`status status-${status}`}>{status}</span>
			</header>
			<main className="workspace">
				<div className="chat-col">
					<ChatPanel messages={state.chat} status={status} working={working} onSend={send} />
				</div>
				<AgentsPanel agents={state.agents} comms={state.comms} />
			</main>
		</div>
	);
}
