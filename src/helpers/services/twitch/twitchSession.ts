import type { Account } from '../../json/accounts';
import type { ConnectionUpdate } from '../../connectionStatus';
import { safeLogText } from '../../safeLog';
import twitchApi, { createEventSubParamsList } from './twitchApi';
import twitchAuth, { TwitchReauthorizationError } from './twitchAuth';

const ENDPOINT = 'wss://eventsub.wss.twitch.tv/ws';
type SocketState = {
	socket: WebSocket;
	timer?: ReturnType<typeof setTimeout>;
	welcome: boolean;
	replacement: boolean;
};

/**
 * Owns every socket and timer for a single account, including reconnect
 * handoff.
 */
export function startTwitchSession(
	options: {
		account: Account;
		onNotification: (
			message: Twitch.WebsocketMessage.Notification,
		) => Promise<void>;
		onReauthorize: () => void;
		onStatus?: (status: ConnectionUpdate) => void;
	},
	dependencies = {
		open: (url: string) => new WebSocket(url),
		validate: twitchAuth.getValidTokens,
		subscribe: twitchApi.createEventSub,
	},
) {
	const { account } = options;
	let stopped = false;
	let opening = false;
	let attempt = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let active: SocketState | undefined;
	let replacement: SocketState | undefined;
	const sockets = new Set<SocketState>();
	const controller = new AbortController();
	const seen = new Set<string>();
	const pending: Twitch.WebsocketMessage.Notification[] = [];
	let draining = false;

	function close(state: SocketState) {
		clearTimeout(state.timer);
		sockets.delete(state);
		state.socket.onmessage =
			state.socket.onclose =
			state.socket.onerror =
				null;
		state.socket.close();
		if (active === state) active = undefined;
		if (replacement === state) replacement = undefined;
	}
	function stop() {
		stopped = true;
		controller.abort();
		clearTimeout(retry);
		for (const state of sockets) close(state);
		pending.length = 0;
	}
	function fail(error: unknown) {
		if (stopped) return;
		console.warn(
			`Twitch connection for ${account.displayName}:`,
			safeLogText(error),
		);
		if (error instanceof TwitchReauthorizationError) {
			stop();
			options.onReauthorize();
			return;
		}
		for (const state of sockets) close(state);
		pending.length = 0;
		if (retry !== undefined) return;
		const wait =
			Math.min(1000 * 2 ** Math.min(attempt++, 5), 30_000) +
			Math.floor(Math.random() * 500);
		options.onStatus?.({
			state: 'reconnecting',
			retryAt: Date.now() + wait,
			transport: 'websocket',
		});
		retry = setTimeout(() => {
			retry = undefined;
			void open();
		}, wait);
	}
	function watchdog(state: SocketState, milliseconds: number) {
		clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			if (state === replacement && active?.welcome) {
				close(state); // Failed handoff: recover with a fresh session below.
			}
			fail(new Error('Twitch welcome/keepalive deadline expired.'));
		}, milliseconds);
	}
	async function drain() {
		if (draining) return;
		draining = true;
		try {
			while (!stopped && pending.length) {
				const message = pending.shift()!;
				const id = message.metadata.message_id;
				if (seen.has(id)) continue;
				await options.onNotification(message);
				seen.add(id);
				if (seen.size > 2000) seen.delete(seen.values().next().value!);
			}
		} catch (error) {
			fail(error);
		} finally {
			draining = false;
		}
	}
	async function open(url?: string) {
		if (stopped || (!url && (opening || active)) || (url && replacement))
			return;
		opening = true;
		options.onStatus?.({ state: 'connecting', transport: 'websocket' });
		try {
			if (!url) await dependencies.validate(account.id);
			if (stopped) return;
			if (url) {
				const target = new URL(url);
				if (
					target.protocol !== 'wss:' ||
					target.hostname !== 'eventsub.wss.twitch.tv'
				)
					throw new Error('Invalid Twitch reconnect endpoint.');
			}
			const state: SocketState = {
				socket: dependencies.open(url ?? ENDPOINT),
				welcome: false,
				replacement: Boolean(url),
			};
			sockets.add(state);
			if (url) replacement = state;
			else active = state;
			watchdog(state, 20_000);
			let keepalive = 30_000;
			state.socket.onmessage = event => {
				if (stopped || !sockets.has(state)) return;
				void (async () => {
					if (
						typeof event.data !== 'string' ||
						event.data.length > 1_048_576
					)
						throw new Error('Invalid Twitch event size.');
					const message = JSON.parse(
						event.data,
					) as Twitch.WebsocketMessage.Any;
					switch (message.metadata.message_type) {
						case 'session_welcome': {
							if (state.welcome) return;
							state.welcome = true;
							const welcome =
								message as Twitch.WebsocketMessage.Welcome;
							keepalive = Math.max(
								10_000,
								(welcome.payload.session
									.keepalive_timeout_seconds ?? 30) * 1200,
							);
							watchdog(state, keepalive);
							if (state.replacement) {
								const old = active;
								active = state;
								replacement = undefined;
								if (old) close(old);
							} else {
								for (const param of createEventSubParamsList(
									account.serviceId,
								)) {
									if (stopped || !sockets.has(state)) return;
									await dependencies.subscribe(
										account,
										welcome.payload.session.id,
										param,
										controller.signal,
									);
								}
							}
							attempt = 0;
							if (stopped || !sockets.has(state)) return;
							options.onStatus?.({
								state: 'connected',
								transport: 'websocket',
							});
							console.info(
								'Twitch chat connected:',
								account.displayName,
							);
							break;
						}
						case 'session_keepalive':
							watchdog(state, keepalive);
							break;
						case 'notification':
							watchdog(state, keepalive);
							if (pending.length >= 256)
								throw new Error(
									'Twitch dispatch queue full; reconnecting.',
								);
							pending.push(
								message as Twitch.WebsocketMessage.Notification,
							);
							void drain();
							break;
						case 'session_reconnect':
							watchdog(state, 30000);
							void open(
								(message as Twitch.WebsocketMessage.Reconnect)
									.payload.session.reconnect_url,
							);
							break;
						case 'revocation': {
							const status = (
								message as Twitch.WebsocketMessage.Revocation
							).payload.subscription.status;
							if (
								status === 'authorization_revoked' ||
								status === 'user_removed'
							)
								throw new TwitchReauthorizationError(
									'Twitch authorization was revoked.',
								);
							console.warn(
								'Twitch subscription revoked:',
								status,
							);
						}
					}
				})().catch(error => {
					if (sockets.has(state)) fail(error);
				});
			};
			state.socket.onerror = () => {
				if (sockets.has(state)) fail(new Error('Twitch socket error.'));
			};
			state.socket.onclose = () => {
				if (!sockets.has(state)) return;
				close(state);
				if (!replacement) fail(new Error('Twitch socket closed.'));
			};
		} catch (error) {
			fail(error);
		} finally {
			opening = false;
		}
	}
	void open();
	return { stop };
}
