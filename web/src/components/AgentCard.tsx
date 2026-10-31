import type {KeyboardEvent} from 'react';
import {KIND_META, statusLabel} from '../lib/agents';
import type {AgentView} from '../state/store';

type Props = {agent: AgentView; selected: boolean; onSelect: () => void};

export default function AgentCard({agent, selected, onSelect}: Props) {
	const meta = KIND_META[agent.info.kind];
	const recent = agent.activity.slice(-3);

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onSelect();
		}
	};

	return (
		<div
			role="button"
			tabIndex={0}
			aria-pressed={selected}
			onClick={onSelect}
			onKeyDown={onKeyDown}
			className={`card st-${agent.status} ${agent.status !== 'idle' ? 'is-active' : ''} ${selected ? 'is-selected' : ''}`}
		>
			<header className="card-head">
				<div className="card-title">
					<strong>{meta.label}</strong>
					<small>{agent.info.name}</small>
				</div>
				<span className="chip">{statusLabel(agent.status, agent.tool)}</span>
			</header>

			<ul className="activity">
				{recent.length === 0 && <li className="tone-empty">No activity yet</li>}
				{recent.map((item, index) => (
					<li key={`${item.at}-${index}`} className={`tone-${item.tone}`}>
						{item.text}
					</li>
				))}
			</ul>
		</div>
	);
}
