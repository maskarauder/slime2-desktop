# Shared widget storage

Widgets can opt into a JSON key/value store shared by all installed copies
with the same `storageNamespace` in their `core/config/meta.json`:

```json
{ "storageNamespace": "creator:my-widget" }
```

Namespaces accept lowercase ASCII letters, numbers, `-`, `_`, `.`, and `:`
(maximum 120 characters). Copies retain this declaration. Widgets without a
namespace cannot use these requests. Namespace sharing is intentional and is
not a security boundary between installed widgets.

The app owns file access, serializes operations within each namespace/scope,
and keeps an in-memory cache. Widgets never supply a file path. The API has
no knowledge of chat platforms, account linking, or particular widget data.

## Requests

All payload fields are strings, matching the overlay WebSocket protocol.
`scope` is `persistent` (disk plus memory) or `session` (app memory only).

```js
const current = await slime2.request('get-shared-widget-storage', {
  scope: 'persistent', key: 'preferences',
})

const saved = await slime2.request('set-shared-widget-storage', {
  scope: 'persistent',
  key: 'preferences',
  value_json: JSON.stringify({ theme: 'green' }),
  mode: 'set-if-absent', // or 'set' to replace the value
  operation_id: 'optional-unique-event-id',
})

await slime2.request('delete-shared-widget-storage', {
  scope: 'persistent', key: 'preferences',
})
```

Results contain `namespace`, `scope`, `key`, `value`, `found`, `revision`, and
`updated`. `found` distinguishes a missing key from a stored JSON null.
Deletion also returns `deleted: true`.

`set-if-absent` returns the winning stored value if several instances attempt
to initialize the same key. For an intentional update triggered by a chat
event seen by several instances, use the same `operation_id` everywhere.
The first proposed value wins for that operation. Retried operations return
the original result with `updated: false`. The app retains the last 1,000
operation results across namespaces until restart. Reusing an operation ID
for another key or mode is an error. This is duplicate suppression for
concurrent delivery, not permanent event history.

Each get/set/delete request subscribes the widget ID to change notifications:

```js
addEventListener('slime2:shared-widget-storage-change', ({ detail }) => {
  // detail has the same shape as a request result.
  // Compare per-key revisions before replacing cached data.
})
```

Notifications reach subscribed overlay and bot instances. Subscribers are
forgotten when a widget is removed or its core changes. Refresh cached data
after reconnect because notifications missed while disconnected are not replayed.

## Files and limits

Persistent data is under the app config directory at:

`config/widget_storage/ns-<encoded-namespace>.json`

The namespace is URI-encoded, including dots. Files have a version, a revision,
and a `values` object. Writes use a flushed temporary file in the same
directory followed by replacement, and are acknowledged only after the save
finishes. Save failures preserve the previous in-memory value. A malformed
existing file is reported as an error, never silently replaced with an empty
database. Back up this directory while Slime2 is closed; direct edits while
the app is running are not observed.

Keys and operation IDs are limited to 240 characters, values to 64 KiB, JSON
nesting to 64 levels, and each namespace/scope to 4 MiB. These are small widget
state stores, not message archives. `session` data resets when the app frontend
restarts. All cooperating widget copies should use the same scope.

## Changed project files

- `src/helpers/json/widgetSharedStorage.ts`: validation, serialization, cache,
  duplicate suppression, and notifications.
- `src/helpers/json/widgetMeta.ts`: the optional namespace declaration.
- `src/helpers/commands.ts`, `src-tauri/src/commands.rs`,
  `src-tauri/src/file.rs`, `src-tauri/src/main.rs`: atomic JSON save command.
- `src/hooks/useWidgetRequest.ts`: request validation and dispatch.
- `src/helpers/widgetMessage.ts`, `src/hooks/useTwitchBot.ts`: change events.
- `src-overlay/src/hooks/useSlime2Websocket.ts`: bounded request lifetime and
  rejection of pending requests on disconnect.

Run the isolated storage regression checks with:

```sh
node --test tests/widget-shared-storage.test.mjs tests/overlay-widget-request.test.mjs
```
