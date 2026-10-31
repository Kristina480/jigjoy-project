import {KIND_META, formatTime, statusLabel} from '../lib/agents';
import type {AgentView} from '../state/store';

export default function AgentCard({agent}: {agent: AgentView}) {
	const meta = KIND_META[agent.info.kind];
	const task = agent.tasks.at(-1);
	const earlier = agent.tasks.length - 1;
	const recent = agent.activity.slice(-4);

	return (
		<article className={`card card-${agent.status}`} style={{['--accent' as string]: meta.color}}>
			<header className="card-head">
				<span className="dot" />
				<div className="card-title">
					<strong>{meta.label}</strong>
					<small>{agent.info.name}</small>
				</div>
				<span className={`chip chip-${agent.status}`}>{statusLabel(agent.status, agent.tool)}</span>
			</header>

			{task && (
				<div className="task">
					<div className="task-head">
						<span className={`badge badge-${task.status}`}>{task.status}</span>
						<span className="muted">
							task {earlier > 0 && `(+${earlier} earlier)`} · {formatTime(task.at)}
						</span>
					</div>
					<p className="clamp">{task.task}</p>
					{task.criteria.length > 0 && (
						<details>
							<summary>{task.criteria.length} acceptance criteria</summary>
							<ul>
								{task.criteria.map(item => (
									<li key={item}>{item}</li>
								))}
							</ul>
						</details>
					)}
				</div>
			)}

			{task?.result && (
				<div className="result">
					<p>{task.result.summary}</p>
					<ResultList title="Files" items={task.result.filesChanged} />
					<ResultList title="Checks" items={task.result.checks} />
					<ResultList title="Blockers" items={task.result.blockers} danger />
				</div>
			)}

			{recent.length > 0 && (
				<ul className="activity">
					{recent.map((item, index) => (
						<li key={`${item.at}-${index}`} className={`tone-${item.tone}`}>
							{item.text}
						</li>
					))}
				</ul>
			)}
		</article>
	);
}

function ResultList({title, items, danger}: {title: string; items: string[]; danger?: boolean}) {
	if (items.length === 0) return null;
	return (
		<div className={`result-list ${danger ? 'danger' : ''}`}>
			<span>{title}</span>
			<ul>
				{items.map(item => (
					<li key={item}>{item}</li>
				))}
			</ul>
		</div>
	);
}
