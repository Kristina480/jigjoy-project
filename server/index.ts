import 'dotenv/config';
import http from 'node:http';
import {WebSocket, WebSocketServer} from 'ws';
import {createAgentSession} from '../source/session.js';
import type {ClientEvent, ServerEvent} from '../shared/events.js';

const PORT = Number(process.env['PORT'] ?? 3001);
const clients = new Set<WebSocket>();

function broadcast(event: ServerEvent) {
	const data = JSON.stringify(event);
	for (const client of clients) {
		if (client.readyState === WebSocket.OPEN) client.send(data);
	}
}

if (!process.env['OPENAI_API_KEY']) {
	console.warn('[server] OPENAI_API_KEY is not set - the agents will fail.');
}

// The Mozaik runtime keeps global state (one coordinator id, one runtime),
// so we create ONE shared session and broadcast its output to every client.
const session = createAgentSession({
	onAssistantText: text => broadcast({type: 'assistant', text}),
	onFunctionCall: name => broadcast({type: 'tool', name}),
});

// Agent failures (bad key, network...) surface as unhandled rejections.
process.on('unhandledRejection', reason => {
	const message = reason instanceof Error ? reason.message : String(reason);
	console.error('[server] unhandled rejection:', reason);
	broadcast({type: 'error', message});
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
	socket.send(JSON.stringify({type: 'ready'} satisfies ServerEvent));

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
