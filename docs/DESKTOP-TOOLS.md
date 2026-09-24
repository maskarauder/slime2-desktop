# Desktop tools

All source paths here are relative to the project root. These tools reuse the
existing readers and storage: each account still has one connection regardless
of how many browser sources or layouts are open.

## Accounts

Chat connections shows actual reader states and the next scheduled attempt.
Connected, quiet chat stays connected. YouTube shows gRPC or REST; the REST
countdown indicates the next poll and retains the 30-second minimum. Reconnect
now cancels/replaces only that account's reader. Sign in again opens the existing
authorization dialog. Unassigned read accounts are idle.

`src/helpers/connectionStatus.ts` uses per-reader ownership to ignore stale
callbacks. The account hooks publish state from the transports rather than
inferring a disconnection from missing chat messages.

Linked viewer accounts lists widgets that opt into a generic editor. Select a
widget, search/select or create an identity, and enter comma-separated Twitch
usernames, YouTube @handles and TikTok usernames. Lookups use that widget's
assigned read accounts. Numeric Twitch/TikTok IDs and 24-character YouTube UC
channel IDs work directly. Prefix an all-numeric username with @ for lookup.

Save resolves every input before writing. Ownership conflicts reject the save.
A chat command or other layout changing the mapping rejects a stale draft:
Reload before editing again. Identity keys stay fixed to preserve widget data.
Unlink removes the mapping but leaves the identity's other saved data. Links
do not prove account ownership or grant roles.

Desktop does not know Villager Chat's schema. A compatible widget declares its
own fields in `core/config/meta.json`, for example:

```json
{
  "storageNamespace": "example:chat",
  "accountLinkEditor": {
    "key": "identities",
    "idField": "viewer",
    "accountsField": "identities",
    "platformField": "site",
    "accountField": "uid"
  }
}
```

The persistent value in this example is
`[{"viewer":"viewer_1","identities":[{"site":"twitch","uid":"12345"}]}]`.
Keys are case-insensitively unique, 1–80 letters/numbers/underscores/hyphens.
Collections allow at most 1,000 identities. IDs remain strings; YouTube IDs are
case-sensitive. Additional top-level record properties are preserved. Linked
account entries use only the two declared fields. Widgets observe storage
changes and retain their own mapping/selection policy.

Implementation: `src/helpers/accountLinkEditor.ts`,
`src/helpers/json/widgetMeta.ts`, `src/pages/accounts/AccountLinks.tsx`,
`src/pages/accounts/ConnectionDashboard.tsx`.

## Diagnostics and backup

Settings > Diagnostics exports JSON with the app version, connection states,
installed widget names/versions and the current log's recent tail. Native input
is capped at 512 KiB; output is capped at 2,000 lines. Existing safe-log redaction
removes recognized credential fields. HTTP URL query strings, fragments and
userinfo are removed; local overlay URLs are omitted. The export does not read
the keyring or widget settings. Logs can contain usernames, chat text or paths:
review the file before sharing it.

Settings > Backup and restore saves widgets, widget settings, layouts, uploaded
media, account metadata/assignments and persistent shared widget storage.
OAuth tokens, client secrets and Euler keys stay in the OS credential store.
Session storage, logs, event history and executables are not exported. Widget
files/settings can contain private information: keep backups private. Avoid
editing widgets/shared state during export. Queued saves are flushed first;
the filesystem snapshot is not a transaction across live chat activity.

Restore stages and validates the ZIP, asks for confirmation, then restarts and
replaces the backed-up categories. Restored accounts require sign-in again,
even on the same computer. Reuse existing account entries to retain assignments.
Only restore trusted backups; widget scripts execute when loaded. Copy fresh
overlay URLs when moving to a different installation. Cancelling a preview
removes its staged files.

The archive has a `manifest.json` with format `slime2-backup`, version `1`, and
the app version. Only recognized `config/`, `tiles/` and `media/` paths are
accepted. Limits: 2 GiB compressed/expanded data, 50,000 files, 16 MiB per config
JSON. Traversal, symlinks, duplicate case-insensitive filenames and nonportable
Windows paths are rejected. Tile layout must match archived tiles to prevent
startup cleanup from discarding them. Restore runs before readers/watchers;
a journal rolls back interrupted directory swaps on the next launch. Local
config outside the backup contract, including event history, is retained.

Implementation: `src-tauri/src/backup.rs`, `src-tauri/src/commands/backup.rs`,
`src-tauri/src/commands/diagnostics.rs`, `src/helpers/diagnostics.ts`,
`src/helpers/json/queueSaveJson.ts`, `src/pages/settings/DataTools.tsx`.

## Simulator

Event Simulator adds Twitch, YouTube and TikTok previews, native emotes,
Twitch GIF messages, YouTube paid/membership events and TikTok gifts. Select a compatible overlay or
all compatible overlays. Bursts are sequential, capped at 100 events with at
least 100 ms between events. Stop or leaving the panel cancels a burst.
Previews need no live account, request no chat API and dispatch no bot events.
They carry `mock: true`. Existing Twitch tools keep their account-based routing.

Mock YouTube events may carry `simulationFragments` for native emotes without
catalog lookup. Widgets must use these only when `mock` is true. Live TikTok
Euler v2 gift streaks are normalized on the final update to avoid duplicate
display messages. Their payload has text and `gift` ID/name/count/completion;
no gift animation/video is downloaded. Widgets decide which events to render.

Implementation: `src/helpers/simulator.ts`,
`src/pages/simulator/PlatformSimulator.tsx`, `src/helpers/widgetMessage.ts`,
`src/helpers/services/tiktok/tiktokEvents.ts`.

See [TWITCH-GIFS.md](TWITCH-GIFS.md) for GIF rendering, resource limits and
updating existing widget copies.

## Updates and About

Settings checks the fork's public GitHub releases. Stable excludes prereleases;
Test includes them. Drafts, debug tags and releases without uploaded downloads
are excluded. Checks time out after 15 seconds and report API rate limits.
Optional startup checks are off by default and run once per launch using the
saved release channel.
New releases appear in a dismissible banner. **Install and restart** downloads
and verifies the matching signed installer, saves pending settings and relaunches
Slime2. The optional **Automatically install the latest update at startup**
checkbox is off by default and takes effect on the next launch. Manual update
checks do not automatically install. Releases without updater metadata and
unsupported installation formats still link to the manual downloads. See
[AUTOMATIC-UPDATES.md](AUTOMATIC-UPDATES.md) for release signing setup and details.
About links to the fork's source, releases and issues and retains upstream credits.

Implementation: `src/helpers/updates.ts`, `src/components/UpdateNotice.tsx`,
`src/pages/settings/UpdateSettings.tsx`, `src/components/dialog/AboutDialog.tsx`.
