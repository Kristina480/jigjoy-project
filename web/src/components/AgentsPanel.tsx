import {getTeamActivity} from '../state/store';
import {useState} from 'react';
import {KIND_META} from '../lib/agents';
import type {CommView, AgentView} from '../state/store';
import AgentCard from './AgentCard';
import AgentDetail from './AgentDetail';
import CommsLog from './CommsLog';

export default function AgentsPanel({agents, comms}: {agents: Record<string, AgentView>; comms: CommView[]}) {
	const activity = getTeamActivity(agents);
	const [selectedId, setSelectedId] = useState<string>();
	const cards = Object.values(agents)
		.filter(agent => agent.info.kind !== 'user' && !agent.retired)
		.sort((a, b) => KIND_META[a.info.kind].order - KIND_META[b.info.kind].order);
	const selected = cards.find(agent => agent.info.id === selectedId) ?? cards[0];

	return (
		<aside className="agents-panel">
			<div className="agents-inner">
				<section className="agents-section">
					<h2>Agents <small aria-live="polite">{activity.working} working · {activity.total} specialists</small></h2>
					<div className="agents-split">
						<div className="agents-list">
							{cards.map(agent => (
								<AgentCard
									key={agent.info.id}
									agent={agent}
									selected={agent.info.id === selected?.info.id}
									onSelect={() => setSelectedId(agent.info.id)}
								/>
							))}
						</div>
						{selected && <AgentDetail agent={selected} />}
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
