export const FORK_URL = 'https://github.com/maskarauder/slime2-desktop';
export type UpdateChannel = 'stable' | 'test';
type Release = {
	tag_name: string;
	html_url: string;
	draft: boolean;
	prerelease: boolean;
	assets: { state: string; size: number; name?: string }[];
};
export type AvailableUpdate = {
	tag: string;
	url: string;
	channel: UpdateChannel;
	hasManifest: boolean;
};
let available: AvailableUpdate | null = null;
let checkGeneration = 0;
const listeners = new Set<() => void>();
export const getAvailableUpdate = () => available;
export function subscribeUpdates(callback: () => void) {
	listeners.add(callback);
	return () => {
		listeners.delete(callback);
	};
}
function parseVersion(input: string) {
	const match =
		/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
			input,
		);
	return match
		? {
				numbers: match.slice(1, 4).map(Number),
				pre: match[4]?.split('.') ?? [],
			}
		: null;
}
export function compareVersions(a: string, b: string) {
	const left = parseVersion(a),
		right = parseVersion(b);
	if (!left || !right) throw Error('Unrecognized app or release version.');
	for (let i = 0; i < 3; i++)
		if (left.numbers[i] !== right.numbers[i])
			return Math.sign(left.numbers[i]! - right.numbers[i]!);
	if (!left.pre.length || !right.pre.length)
		return Number(!left.pre.length) - Number(!right.pre.length);
	for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
		const x = left.pre[i],
			y = right.pre[i];
		if (x === y) continue;
		if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
		const xn = /^\d+$/.test(x),
			yn = /^\d+$/.test(y);
		if (xn && yn) return Math.sign(Number(x) - Number(y));
		if (xn !== yn) return xn ? -1 : 1;
		return x < y ? -1 : 1;
	}
	return 0;
}
export function selectRelease(releases: Release[], channel: UpdateChannel) {
	return releases
		.filter(release => {
			if (
				!release ||
				typeof release.tag_name !== 'string' ||
				!Array.isArray(release.assets)
			)
				return false;
			const version = parseVersion(release.tag_name);
			return (
				version &&
				!release.draft &&
				!version.pre.some(p => /debug/i.test(p)) &&
				(channel === 'test' ||
					(!release.prerelease && !version.pre.length)) &&
				release.html_url ===
					`${FORK_URL}/releases/tag/${release.tag_name}` &&
				release.assets.some(
					a => a && a.state === 'uploaded' && a.size > 0,
				)
			);
		})
		.sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
}
export async function checkForUpdate(
	current: string,
	channel: UpdateChannel,
	signal?: AbortSignal,
) {
	const generation = ++checkGeneration;
	const response = await fetch(
		'https://api.github.com/repos/maskarauder/slime2-desktop/releases?per_page=100',
		{
			headers: {
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
			},
			signal: AbortSignal.any([
				AbortSignal.timeout(15000),
				...(signal ? [signal] : []),
			]),
		},
	);
	if (response.status === 403 || response.status === 429)
		throw Error('GitHub rate limit reached. Try again later.');
	if (!response.ok)
		throw Error(`Update check failed (HTTP ${response.status}).`);
	const data: unknown = await response.json();
	if (!Array.isArray(data))
		throw Error('GitHub returned an invalid release list.');
	const release = selectRelease(data, channel),
		newer = release
			? compareVersions(release.tag_name, current) > 0
			: false;
	if (!signal?.aborted && generation === checkGeneration) {
		available =
			release && newer
				? {
						tag: release.tag_name,
						url: release.html_url,
						channel,
						hasManifest: release.assets.some(
							a =>
								a?.name === 'latest.json' &&
								a.state === 'uploaded' &&
								a.size > 0,
						),
					}
				: null;
		listeners.forEach(fn => fn());
	}
	return { release, newer };
}
