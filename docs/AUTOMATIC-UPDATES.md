# Automatic updates

In **Settings > Updates**, enable **Automatically install the latest update at
startup** to install a newer signed release on the next launch. The setting is
off by default. Slime2 uses the selected stable/test release channel, chooses the
installer for the current app platform and architecture, verifies its signature,
installs it and relaunches. Windows may show a UAC administrator prompt.

Automatic installation runs once at startup, not periodically during a session.
Turning on the checkbox does not immediately install anything. **Check for
updates** is a manual check; **Install and restart** explicitly starts the update.
Restarting briefly disconnects chat readers and widgets. Save edits before a
manual update. A failed check/download/signature verification leaves the running
installation in place and reports an error; the release link remains available
for manual installation.

Supported automatic installations are Windows MSI, macOS app bundles and Linux
AppImage, in x64 or ARM64 builds. Linux `.deb`, `.rpm` and Arch package installs
continue using their package manager/manual installer. Development builds and
builds without a configured signing public key do not offer automatic installs.
Settings and widgets are stored separately from the installed executable; an
update does not reset them.

## One-time maintainer setup

Run these commands from the project root after `npm run setup`. Generate the key
outside the repository. This PowerShell example saves it in your user directory:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.tauri"
npm run tauri -- signer generate -w "$env:USERPROFILE\.tauri\slime2-updater.key"
npm run updater:configure -- "$env:USERPROFILE\.tauri\slime2-updater.key.pub"
```

The helper (`scripts/updater-config.mjs`) copies only the **public** `.pub` key into
`src-tauri/tauri.conf.json`, at `plugins.updater.pubkey`. Commit that configuration
change. It rejects private keys and accidental replacement of an existing public
key. It does not generate or upload private keys.

In the GitHub repository, open **Settings > Secrets and variables > Actions** and
add repository secrets:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Complete contents of `slime2-updater.key`, not its local file path |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password chosen when generating the key; omit if the key has no password |

Keep a secure backup of the private key and its password. Installed apps trust the
public key embedded when they were built. Losing/changing the corresponding
private key prevents those apps from trusting future updates; key rotation needs
a planned migration, not another ordinary configure command. Updater signatures
are separate from Windows/macOS operating-system code-signing certificates.

## Publishing updates

1. Increment the numeric application version, for example:

   ```powershell
   npm run version:set -- 1.5.3
   npm run verify
   ```

2. Commit the source/version changes and the configured public key. Merge/push the
   version you want to publish to `release/live` for a stable release, or the
   existing `release/test`, `release/beta` or `release/debug` branches for those
   channels. The publish workflow can also be dispatched on the intended release
   branch. Dispatching on another branch uses the existing test-channel suffix.

3. Wait for `.github/workflows/main.yml` to finish. It creates a draft first,
   verifies/builds all six OS/architecture targets and uploads signed updater
   artifacts. The final job validates all six installers and matching signature
   assets/key IDs, creates and uploads `latest.json` once, then publishes. Stable
   releases are marked as non-prerelease and latest; test/beta/debug releases stay
   prereleases. The Arch recipe ZIP is added afterward because its checksum step
   needs the published `.deb` download URLs.

4. Install this updater-enabled build manually once. Older builds without this
   functionality cannot update themselves retroactively. Later signed releases
   with a higher numeric version can install through Slime2.

Use a **new numeric version for every update that should replace an installed
build**, including promotion between channels. Tags such as `v1.5.3-test` still
contain an app whose internal version is `1.5.3`; publishing `v1.5.3` afterward
does not constitute a newer installed version. The updater does not downgrade or
reinstall an equal version. Do not replace assets on a published release.

An interrupted matrix build leaves an unpublished draft. Rerun failed jobs for the
same commit. If you change the source, use a new version or delete the unpublished
draft and rerun **all** build jobs so one release cannot mix different commits.
An existing release tag must also point at the exact commit being built. If the
final check identifies a missing asset, rerun its platform build for that commit,
then rerun the final publication job.
If only the Arch recipe job fails, the signed installers are already published;
rerun that job, not the complete release workflow.

## Local builds and troubleshooting

Regular `npm run build -- --bundles msi`, `npm run verify` and pull-request CI do
not require private signing secrets. Only the publish workflow enables
`bundle.createUpdaterArtifacts` using a build-time configuration override. A
locally built release with the configured public key can receive future signed
updates; its ordinary unsigned local MSI is not itself an automatic update asset.

To check the committed public key without building:

```powershell
node scripts/updater-config.mjs --check
```

If no install button is available, check whether this build has a public key,
whether its installation format is supported, and whether the selected GitHub
release has `latest.json` plus the signed installer for your architecture. An MSI
uploaded manually without updater metadata/signatures is still a manual download.
The release workflow creates the necessary artifacts; do not hand-edit the
manifest to point at an unsigned file.

For updater errors, capture the displayed error and nearby Slime2 log lines. Do
not include private signing keys, passwords or authentication tokens. Windows MSI
installation/relaunch, macOS app replacement and AppImage replacement still need
platform smoke tests before relying on unattended updates during a stream.

Implementation references:
[Tauri updater](https://v2.tauri.app/plugin/updater/) and
[Tauri GitHub action](https://github.com/tauri-apps/tauri-action).

## Incomplete updater manifests from earlier workflows

An earlier workflow let every platform build read and rewrite the same
`latest.json`. Those parallel writes could lose platform entries even when all
installer builds succeeded. The final publisher now derives the complete manifest
from the uploaded installers and signatures rather than trusting a partial
manifest. It preserves exact architecture and installer-family matching.

If an installer or signature really is missing, the error identifies the required
asset and platform. Publication stops before replacing the manifest. If all assets
are valid, an incomplete old manifest is replaced with the complete one.

After applying this workflow fix, commit/push it and start a new **Run workflow**
from the updated branch. Use a new application version, or delete the unpublished
draft for the previous commit and rebuild all targets. Rerunning an older workflow
uses that run's original source and cannot pick up this fix.
