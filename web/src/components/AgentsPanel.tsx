import {KIND_META} from '../lib/agents';
import type {CommView, AgentView} from '../state/store';
import AgentCard from './AgentCard';
import CommsLog from './CommsLog';

export default function AgentsPanel({agents, comms}: {agents: Record<string, AgentView>; comms: CommView[]}) {
	const cards = Object.values(agents)
		.filter(agent => agent.info.kind !== 'user')
		.sort((a, b) => KIND_META[a.info.kind].order - KIND_META[b.info.kind].order);

	return (
		<aside className="agents-panel">
			<div className="agents-inner">
				<section className="agents-section">
					<h2>Agents</h2>
					<div className="agents-grid">
						{cards.map(agent => (
							<AgentCard key={agent.info.id} agent={agent} />
						))}
					</div>
				</section>
				<section className="comms-section">
					<h2>Communications</h2>
					<CommsLog comms={comms} agents={agents} />
				</section>
			</div>
		</aside>
	);
}
