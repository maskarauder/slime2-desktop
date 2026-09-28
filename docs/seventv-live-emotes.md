# Live 7TV emote catalogs

Slime2 owns one shared 7TV EventAPI connection for the Twitch and YouTube read
accounts assigned to installed widgets. It loads global and channel emotes,
listens for additions/removals/renames and active-set changes, and reconciles the
catalogs every 15 minutes. Multiple layouts do not create separate upstream
connections or polling timers. These requests go to 7TV, not the YouTube Data API.

Recovery includes heartbeat monitoring, delayed reconnects, resubscription and a
fresh snapshot. It does not assume the service can replay events missed during a
disconnect. Temporary lookup failures retain the last successful data. A valid
empty catalog removes the emotes that are no longer available. Accounts without
a 7TV channel set can still use global emotes; periodic reconciliation discovers
a subsequently linked account or newly assigned set.
Deleting an entire active emote set also removes its emotes immediately. Rate
limits and maintenance use a longer reconnect delay. Fatal protocol/permission
errors stop live retries for that service lifetime while periodic snapshots
remain enabled; restarting the app starts a new attempt.

## Widget API

Request the initial catalog on account assignment and after the local widget
connection reconnects, using the existing request:

```js
const catalog = await slime2.request('get-seventv-user', {
  platform: 'twitch', // or 'youtube'
  account_id: assignedAccount.id,
})
// catalog: { emotes: [{ id, name, srcAnimated, srcStatic }], revision } | null
```

Live changes arrive as complete **7TV-only** replacements through the existing
local connection:

```js
addEventListener('slime2:emote-catalog-update', event => {
  const { provider, platform, account_id, revision, emotes } = event.detail
  // Validate provider/platform/current account, reject older revisions,
  // then replace that provider's catalog and rebuild the combined lookup.
})
```

`provider` is currently `seventv`. `account_id` is the Slime2 read-account ID,
not a 7TV user ID. `revision` orders catalog snapshots within an app session;
it is not a timestamp or persistent version. Reset revision tracking after the
local `slime2:disconnected` event. Ignore outstanding responses for previous
account assignments or connection generations, and do not let an older initial
response overwrite a newer live event. A failed/null response is not an empty
catalog. Widgets using the older response shape without `revision` can continue
loading their initial emotes, but need an event handler to receive live changes.

Keep each provider's catalog separately. Rebuild the combined lookup in its
existing precedence order so removing a 7TV alias reveals any same-named emote
from the next provider. Update lookups used for new messages; there is no need
to recreate messages already displayed or reload the browser source. The built-in
chat widget implements this behavior. Separately installed widgets must implement
the event too; Desktop does not import their code or know their rendering policy.

## Project locations

- `src/helpers/services/emotes/sevenTV.ts`: public catalog facade and HTTP/image handling.
- `src/helpers/services/emotes/sevenTvLive.ts`: shared catalogs, event connection and recovery.
- `src/hooks/useSevenTvEmotes.ts`: account lifecycle and catalog routing.
- `src/helpers/widgetMessage.ts`: generic `emote-catalog-update` delivery.
- `resources/widgets/slime2_overlay_chat_box/script.js`: built-in chat consumer.
- `src-tauri/tauri.conf.json`: permits the 7TV event connection in the app CSP.

The separate Villager Chat widget consumes the same API in `desktop-bridge.js`;
its `tools/build.mjs` generates the installed `script.js`. No villager-specific
logic is included in Slime2.

## Manual smoke test

After building and installing the updated app, update each widget layout's code
and reload its browser source. Keep existing widget IDs, settings and shared
storage. Add an emote to the channel in 7TV and send its name as a new chat message
in each layout. Rename it and remove it, verifying that only subsequent messages
change. Switch active emote sets and repeat. Disconnect/reconnect the network and
verify that catalogs recover without restarting Slime2. A temporary 7TV outage
should leave existing emotes usable, while periodic reconciliation repairs missed
changes. Automated tests use synthetic events and do not establish live service
availability or OBS rendering behavior.
