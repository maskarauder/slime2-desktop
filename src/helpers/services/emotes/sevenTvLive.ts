// One catalog and EventAPI connection per desktop application, never per widget.
export type SevenTvPlatform = 'twitch' | 'youtube';
export type SevenTvAccount = {
	id: string;
	service: SevenTvPlatform;
	serviceId: string;
};
export type SevenTvEmote = {
	id: string;
	name: string;
	srcAnimated: string;
	srcStatic: string;
};
export type SevenTvUpdate = {
	platform: SevenTvPlatform;
	serviceId: string;
	emotes: SevenTvEmote[];
	revision: number;
};
export type RawEmote = {
	id: string;
	name: string;
	data?: {
		animated?: boolean;
		host?: {
			url: string;
			files: {
				name: string;
				static_name?: string;
				width: number;
				format: string;
			}[];
		};
	};
};
export type RawSet = { id: string; emotes?: RawEmote[] };
export type RawUser = {
	user?: { id: string };
	emote_set?: RawSet | null;
	emote_set_id?: string | null;
};
type Timer = ReturnType<typeof setTimeout>;
type Socket = Pick<
	WebSocket,
	| 'readyState'
	| 'onopen'
	| 'onmessage'
	| 'onclose'
	| 'onerror'
	| 'send'
	| 'close'
>;
type Dependencies = {
	loadSet: (id: string, signal: AbortSignal) => Promise<RawSet | null>;
	loadUser: (
		platform: SevenTvPlatform,
		id: string,
		signal: AbortSignal,
	) => Promise<RawUser | null>;
	normalize: (emote: RawEmote) => SevenTvEmote;
	connect: (url: string) => Socket;
	now?: () => number;
	random?: () => number;
	setTimeout?: typeof setTimeout;
	clearTimeout?: typeof clearTimeout;
	warn?: (message: string) => void;
};
type SetState = {
	value?: RawSet | null;
	version: number;
	pending?: Promise<void>;
	again?: boolean;
};
type Channel = {
	platform: SevenTvPlatform;
	serviceId: string;
	userId?: string;
	setId?: string;
	loaded: boolean;
	version: number;
	pending?: Promise<void>;
	again?: boolean;
	channelEmotes: SevenTvEmote[];
	emotes: SevenTvEmote[];
	signature?: string;
	revision: number;
};
const RECONCILE_INTERVAL = 15 * 60_000;
const REQUEST_TIMEOUT = 15_000;
const MAX_CHANNELS = 100;
const MAX_EMOTES = 20_000;
const EVENT_URL = 'wss://events.7tv.io/v3';
const validId = (value: unknown): value is string =>
	typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const validEmote = (value: unknown): value is RawEmote =>
	object(value) &&
	validId(value.id) &&
	typeof value.name === 'string' &&
	value.name.length > 0 &&
	value.name.length <= 256;
function validSet(value: RawSet | null) {
	return (
		value === null ||
		(validId(value.id) &&
			Array.isArray(value.emotes) &&
			value.emotes.length <= MAX_EMOTES &&
			value.emotes.every(validEmote))
	);
}

export function createSevenTvLive(deps: Dependencies) {
	const now = deps.now ?? Date.now;
	const random = deps.random ?? Math.random;
	const schedule = deps.setTimeout ?? setTimeout;
	const cancel = deps.clearTimeout ?? clearTimeout;
	const warn = deps.warn ?? console.warn;
	let controller = new AbortController();
	const channels = new Map<string, Channel>();
	const sets = new Map<string, SetState>();
	// A deleted set may linger in HTTP caches; do not resurrect it immediately.
	const deletedSets = new Map<string, number>();
	const listeners = new Set<(update: SevenTvUpdate) => void>();
	let revision = 0;
	let socket: Socket | undefined;
	let hello = false;
	let heartbeatDeadline = 0;
	let heartbeatInterval = 30_000;
	let connectedAt = 0;
	let subscriptionLimit = 256;
	let attempt = 0;
	let liveDisabled = false;
	let lastWarning = -Infinity;
	let reconnectTimer: Timer | undefined;
	let watchdog: Timer | undefined;
	let reconcileTimer: Timer | undefined;
	let refreshTimer: Timer | undefined;
	const subscriptions = new Map<
		string,
		{ type: string; id: string; deadline?: number }
	>();
	const key = (platform: SevenTvPlatform, id: string) => `${platform}:${id}`;
	const current = (channel: Channel) =>
		channels.get(key(channel.platform, channel.serviceId)) === channel;
	function warning(message: string) {
		if (now() - lastWarning < 60_000) return;
		lastWarning = now();
		warn(message);
	}
	function state(id: string) {
		let found = sets.get(id);
		if (!found) {
			found = { version: 0 };
			sets.set(id, found);
		}
		return found;
	}
	function setKey(id: string) {
		return sets.get('global')?.value?.id === id ? 'global' : id;
	}
	function publish() {
		const global = (sets.get('global')?.value?.emotes ?? []).map(
			deps.normalize,
		);
		for (const channel of channels.values()) {
			const selected = channel.setId
				? sets.get(setKey(channel.setId))
				: undefined;
			// A failed initial fetch is not an authoritative empty catalog. In
			// particular, do not wipe a widget's retained snapshot on reconnect.
			if (
				channel.signature === undefined &&
				(sets.get('global')?.value === undefined ||
					!channel.loaded ||
					(channel.setId && selected?.value === undefined))
			)
				continue;
			if (channel.loaded && !channel.setId) channel.channelEmotes = [];
			else if (selected?.value !== undefined)
				channel.channelEmotes = (selected.value?.emotes ?? []).map(
					deps.normalize,
				);
			const emotes = [...global, ...channel.channelEmotes];
			const signature = JSON.stringify(emotes);
			if (signature === channel.signature) continue;
			channel.signature = signature;
			channel.emotes = emotes;
			channel.revision = ++revision;
			const update = {
				platform: channel.platform,
				serviceId: channel.serviceId,
				emotes,
				revision: channel.revision,
			};
			for (const listener of listeners) {
				try {
					listener(update);
				} catch {
					warning('Unable to deliver a 7TV catalog update.');
				}
			}
		}
	}
	function pruneSets() {
		const needed = new Set([
			'global',
			...Array.from(channels.values(), c => c.setId).filter(
				(id): id is string => !!id,
			),
		]);
		for (const [id, entry] of sets)
			if (!needed.has(id) && !entry.pending) sets.delete(id);
	}
	function isDeleted(id: string) {
		const until = deletedSets.get(id);
		if (until !== undefined && until > now()) return true;
		deletedSets.delete(id);
		return false;
	}
	function refreshSet(id: string): Promise<void> {
		id = setKey(id);
		if (!sets.has(id) && sets.size >= MAX_CHANNELS * 3 + 1)
			return Promise.resolve();
		const entry = state(id);
		if (isDeleted(id)) {
			entry.value = null;
			publish();
			return Promise.resolve();
		}
		if (entry.pending) return entry.pending;
		const version = entry.version;
		const signal = controller.signal;
		let task!: Promise<void>;
		task = (async () => {
			await Promise.resolve();
			try {
				const value = await deps.loadSet(id, signal);
				if (
					signal.aborted ||
					sets.get(id) !== entry ||
					entry.version !== version
				)
					return;
				if (!validSet(value)) throw new Error('Invalid emote set.');
				entry.value = value && isDeleted(value.id) ? null : value;
				publish();
				syncSubscriptions();
			} catch {
				if (!signal.aborted)
					warning(
						'7TV catalog refresh failed; keeping the last available emotes.',
					);
			} finally {
				if (entry.pending === task) entry.pending = undefined;
				if (entry.again && !signal.aborted && sets.get(id) === entry) {
					entry.again = false;
					void refreshSet(id);
				}
				pruneSets();
			}
		})();
		entry.pending = task;
		return task;
	}
	function refreshChannel(channel: Channel): Promise<void> {
		if (channel.pending) return channel.pending;
		const version = channel.version;
		const signal = controller.signal;
		let task!: Promise<void>;
		task = (async () => {
			await Promise.resolve();
			try {
				const user = await deps.loadUser(
					channel.platform,
					channel.serviceId,
					signal,
				);
				if (
					signal.aborted ||
					!current(channel) ||
					channel.version !== version
				)
					return;
				if (
					user !== null &&
					(!object(user) ||
						!validId(user.user?.id) ||
						(!('emote_set' in user) && !('emote_set_id' in user)))
				)
					throw new Error('Invalid user response.');
				channel.userId = validId(user?.user?.id)
					? user.user.id
					: undefined;
				channel.setId = validId(user?.emote_set?.id)
					? user.emote_set.id
					: validId(user?.emote_set_id)
						? user.emote_set_id
						: undefined;
				channel.loaded = true;
				syncSubscriptions();
				if (channel.setId) await refreshSet(channel.setId);
				if (!signal.aborted && current(channel)) publish();
			} catch {
				if (!signal.aborted)
					warning(
						'7TV channel lookup failed; keeping the last available emotes.',
					);
			} finally {
				if (channel.pending === task) channel.pending = undefined;
				if (channel.again && !signal.aborted && current(channel)) {
					channel.again = false;
					void refreshChannel(channel);
				}
				pruneSets();
			}
		})();
		channel.pending = task;
		return task;
	}
	async function reconcile() {
		// User lookup also discovers accounts which joined 7TV since a previous 404.
		await Promise.all([
			refreshSet('global'),
			...Array.from(channels.values(), refreshChannel),
		]);
	}
	function scheduleRefresh() {
		if (refreshTimer !== undefined || !channels.size) return;
		refreshTimer = schedule(() => {
			refreshTimer = undefined;
			void reconcile();
		}, 500);
	}
	function scheduleReconciliation() {
		if (reconcileTimer !== undefined || !channels.size) return;
		reconcileTimer = schedule(() => {
			reconcileTimer = undefined;
			void reconcile();
			scheduleReconciliation();
		}, RECONCILE_INTERVAL);
	}
	function wantedSubscriptions() {
		const wanted = new Map<string, { type: string; id: string }>();
		function add(type: string, id?: string) {
			if (id && !isDeleted(id)) wanted.set(`${type}:${id}`, { type, id });
		}
		add('emote_set.*', sets.get('global')?.value?.id);
		for (const channel of channels.values()) {
			add('user.update', channel.userId);
			add('emote_set.*', channel.setId);
		}
		return new Map(Array.from(wanted).slice(0, subscriptionLimit));
	}
	function send(op: number, type: string, id: string) {
		try {
			socket?.send(
				JSON.stringify({
					op,
					d: { type, condition: { object_id: id } },
				}),
			);
		} catch {
			reconnect();
		}
	}
	function syncSubscriptions() {
		if (!hello || !socket || socket.readyState !== 1) return;
		const wanted = wantedSubscriptions();
		for (const [id, sub] of subscriptions) {
			if (wanted.has(id)) continue;
			subscriptions.delete(id);
			send(36, sub.type, sub.id);
		}
		for (const [id, sub] of wanted) {
			if (!hello) return;
			if (subscriptions.has(id)) continue;
			subscriptions.set(id, {
				...sub,
				deadline: now() + REQUEST_TIMEOUT,
			});
			send(35, sub.type, sub.id);
		}
		watch();
	}
	function watch() {
		if (watchdog !== undefined) cancel(watchdog);
		watchdog = undefined;
		if (!socket) return;
		const deadline = Math.min(
			heartbeatDeadline,
			...Array.from(
				subscriptions.values(),
				sub => sub.deadline ?? Infinity,
			),
		);
		watchdog = schedule(
			() => {
				watchdog = undefined;
				if (now() >= deadline) reconnect();
				else watch();
			},
			Math.max(1, deadline - now()),
		);
	}
	function detach() {
		const old = socket;
		socket = undefined;
		hello = false;
		subscriptions.clear();
		if (watchdog !== undefined) cancel(watchdog);
		watchdog = undefined;
		if (old) {
			old.onopen = old.onmessage = old.onclose = old.onerror = null;
			try {
				old.close();
			} catch {
				/* Already closed. */
			}
		}
	}
	function reconnect(code?: number) {
		detach();
		if (!channels.size || reconnectTimer !== undefined) return;
		if (
			code !== undefined &&
			[4001, 4002, 4003, 4004, 4009, 4010, 4011].includes(code)
		) {
			liveDisabled = true;
			warning(
				'7TV rejected live-update subscriptions; using periodic catalog refresh until this session is restarted.',
			);
			return;
		}
		warning(
			'7TV live emote updates disconnected; reconnecting automatically. Periodic catalog refresh remains enabled.',
		);
		const minimum = code === 4005 || code === 4007 ? 300_000 : 0;
		const delay = Math.max(
			minimum,
			Math.min(
				300_000,
				1000 * 2 ** Math.min(attempt++, 9) * (0.75 + random() * 0.5),
			),
		);
		reconnectTimer = schedule(() => {
			reconnectTimer = undefined;
			connect();
		}, delay);
	}
	function dispatch(type: unknown, body: unknown) {
		if (!object(body) || !validId(body.id)) return;
		if (type === 'user.update') {
			for (const channel of channels.values()) {
				if (channel.userId !== body.id) continue;
				// A user event can replace the active set. Prefer its authoritative
				// nested value; an in-flight HTTP response must not restore the old set.
				const updates = Array.isArray(body.updated) ? body.updated : [];
				let found = false;
				for (const field of updates) {
					if (
						!object(field) ||
						field.key !== 'connections' ||
						!Array.isArray(field.value)
					)
						continue;
					for (const item of field.value) {
						if (
							!object(item) ||
							item.key !== 'emote_set_id' ||
							!(item.value === null || validId(item.value))
						)
							continue;
						channel.version++;
						channel.loaded = true;
						channel.setId = item.value ?? undefined;
						found = true;
					}
				}
				if (found) {
					if (channel.setId) void refreshSet(channel.setId);
					publish();
					syncSubscriptions();
				} else {
					channel.version++;
					if (channel.pending) channel.again = true;
					scheduleRefresh();
				}
			}
			return;
		}
		if (type === 'emote_set.delete') {
			deletedSets.set(body.id, now() + RECONCILE_INTERVAL);
			while (deletedSets.size > MAX_CHANNELS * 3)
				deletedSets.delete(deletedSets.keys().next().value!);
			const entry = sets.get(setKey(body.id));
			if (!entry) return;
			entry.version++;
			entry.value = null;
			for (const channel of channels.values()) {
				if (channel.setId !== body.id) continue;
				channel.version++;
				channel.setId = undefined;
				channel.loaded = true;
			}
			publish();
			syncSubscriptions();
			return;
		}
		if (type !== 'emote_set.update') return;
		const entry = sets.get(setKey(body.id));
		if (!entry) {
			scheduleRefresh();
			return;
		}
		entry.version++;
		if (!entry.value) {
			entry.again = !!entry.pending;
			scheduleRefresh();
			return;
		}
		let emotes = [...(entry.value.emotes ?? [])];
		let valid = true;
		for (const operation of ['pulled', 'updated', 'pushed'] as const) {
			const fields = body[operation];
			if (fields !== undefined && !Array.isArray(fields)) {
				valid = false;
				break;
			}
			for (const field of (fields ?? []) as unknown[]) {
				if (!object(field) || field.key !== 'emotes') continue;
				const previous = field.old_value;
				const next = field.value;
				if (operation !== 'pulled' && !validEmote(next)) {
					valid = false;
					break;
				}
				if (operation === 'pushed') {
					const value = next as RawEmote;
					emotes = emotes.filter(
						emote =>
							!(
								emote.id === value.id &&
								emote.name === value.name
							),
					);
					emotes.push(value);
				} else {
					// IDs may occur more than once with different channel aliases.
					const index = validEmote(previous)
						? emotes.findIndex(
								e =>
									e.id === previous.id &&
									e.name === previous.name,
							)
						: -1;
					if (index < 0) {
						valid = false;
						break;
					}
					if (operation === 'pulled') emotes.splice(index, 1);
					else emotes[index] = next as RawEmote;
				}
			}
		}
		if (valid && emotes.length <= MAX_EMOTES) {
			entry.value = { ...entry.value, emotes };
			publish();
		} else {
			entry.again = !!entry.pending;
			scheduleRefresh();
		}
	}
	function connect() {
		if (
			socket ||
			!channels.size ||
			reconnectTimer !== undefined ||
			liveDisabled
		)
			return;
		try {
			const opened = deps.connect(EVENT_URL);
			socket = opened;
			heartbeatDeadline = now() + REQUEST_TIMEOUT;
			watch();
			opened.onclose = event => {
				if (socket === opened) reconnect(event?.code);
			};
			opened.onerror = () => {
				if (socket === opened) reconnect();
			};
			opened.onmessage = event => {
				if (socket !== opened) return;
				try {
					if (
						typeof event.data !== 'string' ||
						event.data.length > 4 * 1024 * 1024
					) {
						reconnect();
						return;
					}
					const frame: unknown = JSON.parse(event.data);
					if (!object(frame)) return;
					const data = frame.d;
					if (frame.op === 1 && object(data)) {
						hello = true;
						connectedAt = now();
						heartbeatInterval =
							typeof data.heartbeat_interval === 'number' &&
							Number.isFinite(data.heartbeat_interval)
								? Math.max(
										1000,
										Math.min(
											120_000,
											data.heartbeat_interval,
										),
									)
								: 30_000;
						subscriptionLimit =
							typeof data.subscription_limit === 'number' &&
							data.subscription_limit >= 0
								? Math.min(256, data.subscription_limit)
								: 256;
						heartbeatDeadline = now() + heartbeatInterval * 2.5;
						syncSubscriptions();
						// Current EventAPI does not replay/resume. Restore subscriptions
						// and snapshots on every connection, including a network recovery.
						scheduleRefresh();
					} else if (frame.op === 4 || frame.op === 7) {
						reconnect(
							object(data) && typeof data.code === 'number'
								? data.code
								: undefined,
						);
						return;
					} else if (frame.op === 6) {
						// ERROR has no close code. The server sends ENDOFSTREAM next;
						// keep that frame so rate-limit/fatal retry policy is preserved.
						heartbeatDeadline = now() + REQUEST_TIMEOUT;
					} else if (hello) {
						heartbeatDeadline = now() + heartbeatInterval * 2.5;
						if (now() - connectedAt >= 60_000) attempt = 0;
						if (
							frame.op === 5 &&
							object(data) &&
							data.command === 'SUBSCRIBE' &&
							object(data.data) &&
							object(data.data.condition)
						) {
							const sub = subscriptions.get(
								`${data.data.type}:${data.data.condition.object_id}`,
							);
							if (sub?.deadline !== undefined) {
								sub.deadline = undefined;
								// Fetch only after the subscription is active; invalidate any
								// pre-disconnect request so missed events cannot leave stale data.
								if (sub.type === 'emote_set.*') {
									const entry = state(setKey(sub.id));
									entry.version++;
									if (entry.pending) entry.again = true;
									else void refreshSet(sub.id);
								} else
									for (const channel of channels.values()) {
										if (channel.userId !== sub.id) continue;
										channel.version++;
										if (channel.pending)
											channel.again = true;
										else void refreshChannel(channel);
									}
							}
						} else if (frame.op === 0 && object(data))
							dispatch(data.type, data.body);
					}
					watch();
				} catch {
					reconnect();
				}
			};
		} catch {
			reconnect();
		}
	}
	function stop() {
		detach();
		for (const timer of [reconnectTimer, reconcileTimer, refreshTimer])
			if (timer !== undefined) cancel(timer);
		reconnectTimer = reconcileTimer = refreshTimer = undefined;
		controller.abort();
		controller = new AbortController();
		sets.clear();
		deletedSets.clear();
		attempt = 0;
		liveDisabled = false;
	}
	return {
		setAccounts(accounts: SevenTvAccount[]) {
			const wanted = new Map<string, SevenTvAccount>();
			for (const account of accounts) {
				if (wanted.size >= MAX_CHANNELS) break;
				if (
					(account.service === 'twitch' ||
						account.service === 'youtube') &&
					validId(account.serviceId)
				)
					wanted.set(
						key(account.service, account.serviceId),
						account,
					);
			}
			for (const id of channels.keys())
				if (!wanted.has(id)) channels.delete(id);
			for (const [id, account] of wanted) {
				if (channels.has(id)) continue;
				const channel: Channel = {
					platform: account.service,
					serviceId: account.serviceId,
					loaded: false,
					version: 0,
					channelEmotes: [],
					emotes: [],
					revision: 0,
				};
				channels.set(id, channel);
				void refreshChannel(channel);
			}
			if (!channels.size) {
				stop();
				return;
			}
			if (!sets.get('global')?.value) void refreshSet('global');
			pruneSets();
			connect();
			syncSubscriptions();
			scheduleReconciliation();
		},
		async getUser(
			platform: SevenTvPlatform,
			serviceId: string,
		): Promise<{ emotes: SevenTvEmote[]; revision: number } | null> {
			if (!validId(serviceId)) return null;
			const channel = channels.get(key(platform, serviceId));
			if (channel) {
				const signal = controller.signal;
				await Promise.all([
					sets.get('global')?.pending,
					channel.pending,
				]);
				if (
					signal.aborted ||
					!current(channel) ||
					channel.signature === undefined
				)
					return null;
				return { emotes: channel.emotes, revision: channel.revision };
			}
			// Ad-hoc lookups do not start a socket or retain a channel indefinitely.
			const signal = controller.signal;
			try {
				const [global, user] = await Promise.all([
					deps.loadSet('global', signal),
					deps.loadUser(platform, serviceId, signal),
				]);
				const setId = user?.emote_set?.id ?? user?.emote_set_id;
				const selected =
					user?.emote_set ??
					(setId ? await deps.loadSet(setId, signal) : null);
				if (
					signal.aborted ||
					!validSet(global) ||
					!validSet(selected) ||
					(!global && !selected)
				)
					return null;
				return {
					emotes: [
						...(global?.emotes ?? []),
						...(selected?.emotes ?? []),
					].map(deps.normalize),
					revision: 0,
				};
			} catch {
				return null;
			}
		},
		subscribe(listener: (update: SevenTvUpdate) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		dispose() {
			channels.clear();
			stop();
			listeners.clear();
		},
	};
}
