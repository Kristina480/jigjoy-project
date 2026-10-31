import {useEffect, useRef} from 'react';
import {KIND_META, formatTime, statusLabel} from '../lib/agents';
import type {AgentView} from '../state/store';

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

export default function AgentDetail({agent}: {agent: AgentView}) {
	const meta = KIND_META[agent.info.kind];
	const endRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		endRef.current?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
	}, [agent.info.id, agent.activity.length]);

	return (
		<div className={`detail st-${agent.status}`}>
			<header className="detail-head">
				<div className="card-title">
					<strong>{meta.label}</strong>
					<small>{agent.info.name}</small>
				</div>
				<span className="chip">{statusLabel(agent.status, agent.tool)}</span>
			</header>

			{agent.tasks.map(task => (
				<section key={task.taskId} className="task">
					<div className="task-head">
						<span className={`badge badge-${task.status}`}>{task.status}</span>
						<span className="muted">task · {formatTime(task.at)}</span>
					</div>
					<p>{task.task}</p>
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
					{task.result && (
						<div className="result" style={{marginTop: 10}}>
							<p>{task.result.summary}</p>
							<ResultList title="Files" items={task.result.filesChanged} />
							<ResultList title="Checks" items={task.result.checks} />
							<ResultList title="Blockers" items={task.result.blockers} danger />
						</div>
					)}
				</section>
			))}

			<section className="task">
				<h3>Output</h3>
				{agent.activity.length === 0 ? (
					<p className="muted">No output yet.</p>
				) : (
					<ul className="log">
						{agent.activity.map((item, index) => (
							<li key={`${item.at}-${index}`} className={`tone-${item.tone}`}>
								<time>{formatTime(item.at)}</time>
								<span>{item.text}</span>
							</li>
						))}
					</ul>
				)}
			</section>
			<div ref={endRef} />
		</div>
	);
}
