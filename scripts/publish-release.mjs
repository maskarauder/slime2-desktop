import { validatePublicKey } from './updater-config.mjs';

const targets = [
	['windows-x86_64-msi', 'windows-x86_64', 'Windows-X64.msi'],
	['windows-aarch64-msi', 'windows-aarch64', 'Windows-ARM64.msi'],
	['darwin-x86_64-app', 'darwin-x86_64', 'macOS-X64.app.tar.gz'],
	['darwin-aarch64-app', 'darwin-aarch64', 'macOS-ARM64.app.tar.gz'],
	['linux-x86_64-appimage', 'linux-x86_64', 'Linux-X64.AppImage'],
	['linux-aarch64-appimage', 'linux-aarch64', 'Linux-ARM64.AppImage'],
];
const maxSignatureBytes = 1024 * 1024;

function decodeBase64(value) {
	if (
		!value ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value,
		)
	)
		throw new Error('Invalid base64.');
	return Buffer.from(value, 'base64');
}

function validateSignature(signature, publicKeyId, target, name) {
	let packet;
	try {
		const lines = decodeBase64(signature)
			.toString('utf8')
			.trim()
			.split(/\r?\n/);
		if (
			lines.length !== 4 ||
			!lines[0].startsWith('untrusted comment: ') ||
			!lines[2].startsWith('trusted comment: ') ||
			decodeBase64(lines[3]).length !== 64
		)
			throw new Error('Invalid signature document.');
		packet = decodeBase64(lines[1]);
		if (
			packet.length !== 74 ||
			!['Ed', 'ED'].includes(packet.subarray(0, 2).toString('ascii'))
		)
			throw new Error('Invalid signature packet.');
	} catch {
		throw new Error(`Malformed signature for ${target}: ${name}.`);
	}
	// Check signing-key identity here. The native updater cryptographically
	// verifies the downloaded installer before allowing installation.
	if (packet.subarray(2, 10).toString('hex') !== publicKeyId)
		throw new Error(
			`Signature for ${target} uses a different updater key: ${name}.`,
		);
}

function requireAsset(assets, name, target, signature = false) {
	const matches = assets.filter(asset => asset.name === name);
	if (matches.length !== 1)
		throw new Error(
			`${matches.length ? 'Duplicate' : 'Missing'} ${signature ? 'signature' : 'installer'} for ${target}: expected ${name}. Release remains a draft.`,
		);
	const asset = matches[0];
	if (
		asset.state !== 'uploaded' ||
		!Number.isSafeInteger(asset.id) ||
		asset.id <= 0 ||
		!Number.isSafeInteger(asset.size) ||
		asset.size <= 0 ||
		(signature && asset.size > maxSignatureBytes)
	)
		throw new Error(
			`Invalid or incomplete ${signature ? 'signature' : 'installer'} for ${target}: ${name}.`,
		);
	return asset;
}

/** Build the manifest once, after every matrix job has uploaded its assets. */
export async function publishSignedRelease({
	github,
	context,
	version,
	versionSuffix,
	releaseId,
	publicKey,
	log = () => {},
}) {
	if (
		typeof version !== 'string' ||
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
		!['', '-test', '-beta', '-debug'].includes(versionSuffix)
	)
		throw new Error('Invalid numeric app version or release suffix.');
	const release_id = Number(releaseId);
	if (!Number.isSafeInteger(release_id) || release_id <= 0)
		throw new Error('Invalid release ID.');
	const encodedKey = validatePublicKey(publicKey);
	const publicDocument = Buffer.from(encodedKey, 'base64')
		.toString('utf8')
		.trim()
		.split(/\r?\n/);
	const publicKeyId = Buffer.from(publicDocument[1], 'base64')
		.subarray(2, 10)
		.toString('hex');
	const { owner, repo } = context.repo;
	const tag = `v${version}${versionSuffix}`;
	const { data: release } = await github.rest.repos.getRelease({
		owner,
		repo,
		release_id,
	});
	if (
		release.id !== release_id ||
		release.draft !== true ||
		release.tag_name !== tag ||
		typeof context.sha !== 'string' ||
		!/^[0-9a-f]{40}$/i.test(context.sha) ||
		release.target_commitish !== context.sha
	)
		throw new Error(
			`${tag} must be an unpublished draft from this exact commit. Nothing was changed.`,
		);
	const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
		owner,
		repo,
		release_id,
		per_page: 100,
	});
	const manifest = {
		version,
		notes: release.body || '',
		pub_date: new Date().toISOString(),
		platforms: {},
	};
	for (const [target, alias, suffix] of targets) {
		const name = `Slime2-${tag}_${suffix}`;
		const installer = requireAsset(assets, name, target);
		const signatureAsset = requireAsset(
			assets,
			`${name}.sig`,
			target,
			true,
		);
		const expectedUrl = `https://api.github.com/repos/${owner}/${repo}/releases/assets/${installer.id}`;
		if (installer.url !== expectedUrl)
			throw new Error(`Unexpected installer URL for ${target}: ${name}.`);
		const response = await github.request(
			'GET /repos/{owner}/{repo}/releases/assets/{asset_id}',
			{
				owner,
				repo,
				asset_id: signatureAsset.id,
				headers: { accept: 'application/octet-stream' },
			},
		);
		const bytes = Buffer.from(response.data);
		if (
			bytes.length !== signatureAsset.size ||
			bytes.length > maxSignatureBytes
		)
			throw new Error(`Incomplete signature for ${target}: ${name}.sig.`);
		const signature = bytes.toString('utf8').trim();
		validateSignature(signature, publicKeyId, target, `${name}.sig`);
		const entry = { url: expectedUrl, signature };
		manifest.platforms[target] = entry;
		manifest.platforms[alias] = entry;
		log(`Validated updater metadata for ${target}: ${name}.`);
	}

	// Never merge a previous manifest: successful matrix jobs may have left
	// an incomplete one behind. Validate every asset before any mutation.
	const data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
	for (const asset of assets.filter(asset => asset.name === 'latest.json'))
		await github.rest.repos.deleteReleaseAsset({
			owner,
			repo,
			asset_id: asset.id,
		});
	await github.rest.repos.uploadReleaseAsset({
		owner,
		repo,
		release_id,
		name: 'latest.json',
		data,
		headers: {
			'content-type': 'application/json',
			'content-length': data.length,
		},
	});
	await github.rest.repos.updateRelease({
		owner,
		repo,
		release_id,
		draft: false,
		prerelease: versionSuffix !== '',
		make_latest: versionSuffix === '' ? 'true' : 'false',
	});
	log(`Published ${tag} with all six signed updater installers.`);
	return manifest;
}
