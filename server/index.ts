import 'dotenv/config';
import http from 'node:http';
import {WebSocket, WebSocketServer} from 'ws';
import {stopManagedProcesses} from '../source/terminal/tools.js';
import {createAgentSession} from '../source/session.js';
import type {ClientEvent, ServerEvent} from '../shared/events.js';
import {createTranslator} from './translate.js';

const PORT = Number(process.env['PORT'] ?? 3001);
const MAX_HISTORY = 1500;
const clients = new Set<WebSocket>();

// Roster events are kept forever; everything else is capped. Both are replayed
// to a browser that connects (or reloads) mid-conversation.
const roster: ServerEvent[] = [];
const history: ServerEvent[] = [];

function emit(event: ServerEvent) {
	if (event.type === 'agent.joined' || event.type === 'agent.left') {
		roster.push(event);
	} else {
		history.push(event);
		if (history.length > MAX_HISTORY)
			history.splice(0, history.length - MAX_HISTORY);
	}

	const data = JSON.stringify(event);
	for (const client of clients) {
		if (client.readyState === WebSocket.OPEN) client.send(data);
	}
}

if (!process.env['OPENAI_API_KEY']) {
	console.warn('[server] OPENAI_API_KEY is not set - the agents will fail.');
}

// The Mozaik runtime keeps global state (one coordinator id, one runtime),
// so there is ONE shared session; its events are broadcast to every client.
const session = createAgentSession({
	onAssistantText() {},
	onRuntimeEvent: createTranslator(emit),
});

process.on('unhandledRejection', reason => {
	const message = reason instanceof Error ? reason.message : String(reason);
	console.error('[server] unhandled rejection:', reason);
	emit({type: 'error', message, at: Date.now()});
});

const server = http.createServer((req, res) => {
	if (req.url === '/health') {
		res.writeHead(200, {'Content-Type': 'application/json'});
		res.end(JSON.stringify({ok: true}));
		return;
	}

	res.writeHead(404);
	res.end();
});

const wss = new WebSocketServer({server, path: '/ws'});

wss.on('connection', socket => {
	clients.add(socket);
	socket.send(
		JSON.stringify({
			type: 'history',
			events: [...roster, ...history],
		} satisfies ServerEvent),
	);

	socket.on('message', raw => {
		try {
			const event = JSON.parse(raw.toString()) as ClientEvent;
			if (event.type === 'send' && event.text.trim()) {
				session.send(event.text.trim());
			}
		} catch (error) {
			console.error('[server] bad client message:', error);
		}
	});

	socket.on('close', () => clients.delete(socket));
});

server.listen(PORT, () => {
	console.log(`[server] listening on http://localhost:${PORT} (ws path: /ws)`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => {
		void stopManagedProcesses().finally(() => {
			for (const socket of clients) socket.close();
			wss.close();
			server.close(() => process.exit(0));
		});
	});
}
