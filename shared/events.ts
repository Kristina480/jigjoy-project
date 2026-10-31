// Messages the server pushes to the browser.
export type ServerEvent =
	| {type: 'ready'}
	| {type: 'assistant'; text: string}
	| {type: 'tool'; name: string}
	| {type: 'error'; message: string};

// Messages the browser sends to the server.
export type ClientEvent = {type: 'send'; text: string};
