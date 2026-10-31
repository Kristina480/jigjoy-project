import {useEffect, useRef, useState} from 'react';
import {KIND_META, formatTime} from '../lib/agents';
import type {AgentView, CommView} from '../state/store';

const KIND_LABEL = {user_message: 'message', task: 'task', result: 'result', reply: 'reply'} as const;

function CommItem({comm, agents}: {comm: CommView; agents: Record<string, AgentView>}) {
	const [open, setOpen] = useState(false);
	const from = agents[comm.fromId]?.info;
	const to = agents[comm.toId]?.info;

	return (
		<li className={`comm comm-${comm.kind}`} onClick={() => setOpen(value => !value)}>
			<div className="comm-head">
				<span style={{color: from ? KIND_META[from.kind].color : undefined}}>
					{from ? KIND_META[from.kind].label : '?'}
				</span>
				<span className="arrow">→</span>
				<span style={{color: to ? KIND_META[to.kind].color : undefined}}>
					{to ? KIND_META[to.kind].label : '?'}
				</span>
				<span className="chip">{KIND_LABEL[comm.kind]}</span>
				<span className="muted time">{formatTime(comm.at)}</span>
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
