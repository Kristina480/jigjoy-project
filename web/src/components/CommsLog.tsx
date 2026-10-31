import {useEffect, useRef, useState} from 'react';
import {KIND_META, formatTime} from '../lib/agents';
import type {AgentView, CommView} from '../state/store';

const KIND_LABEL = {user_message: 'message', task: 'task', result: 'result', reply: 'reply'} as const;

function CommItem({comm, agents}: {comm: CommView; agents: Record<string, AgentView>}) {
	const [open, setOpen] = useState(false);
	const from = agents[comm.fromId]?.info;
	const to = agents[comm.toId]?.info;

	return (
		<li className="comm" onClick={() => setOpen(value => !value)}>
			<div className="comm-head">
				<b>{from ? KIND_META[from.kind].label : '?'}</b>
				<span className="arrow">→</span>
				<b>{to ? KIND_META[to.kind].label : '?'}</b>
				<span className="kind">{KIND_LABEL[comm.kind]}</span>
				<span className="time">{formatTime(comm.at)}</span>
			</div>
			<p className={open ? '' : 'clamp'}>{comm.text}</p>
		</li>
	);
}

export default function CommsLog({comms, agents}: {comms: CommView[]; agents: Record<string, AgentView>}) {
	const endRef = useRef<HTMLLIElement>(null);

	useEffect(() => {
		endRef.current?.scrollIntoView({behavior: 'smooth'});
	}, [comms.length]);

	return (
		<ul className="comms">
			{comms.map(comm => (
				<CommItem key={comm.id} comm={comm} agents={agents} />
			))}
			<li ref={endRef} />
		</ul>
	);
}
