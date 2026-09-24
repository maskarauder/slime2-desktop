# Developing Slime2 Desktop

All commands below run from the repository root in PowerShell or a Unix shell.
Paths are relative to the repository unless explicitly labeled as app data.

See [DESKTOP-TOOLS.md](DESKTOP-TOOLS.md) for connection status, diagnostics,
backup/restore, shared account editing, simulation and update checks.

## Setup and verification

Use Node.js 22 (the CI version), npm and stable Rust. The native tests need a C/C++
build toolchain; the full app also needs the [Tauri OS prerequisites](https://v2.tauri.app/start/prerequisites/).
On Windows, install the MSVC C++ build tools and Windows SDK. Linux desktop builds
require GTK/WebKit development libraries; see the Tauri guide. The gRPC crate
supplies its own `protoc` through its locked build dependency.

```sh
npm run setup
npm run verify
npm start
```

`setup` uses `npm ci` for both the desktop and overlay packages. Cargo downloads
the dependencies in the committed lockfiles when checks/builds run. Do not use
`cargo update` as an installation step. If changing an npm dependency, update its
manifest and matching lockfile together and confirm a clean `npm run setup`.

| Command | Checks or output | Additional requirements |
| --- | --- | --- |
| `npm run verify` | App version consistency, Node regression tests/fixtures, TypeScript and production builds for both frontends, generated icons, Rust transport and gRPC tests | Node, Rust and native compilation tools; no live chat credentials |
| `npm run verify -- --desktop` | All normal checks plus locked Cargo tests/compilation of the Tauri app | Tauri dependencies for the host OS |
| `npm run verify -- --web-only` | Versions, Node tests, both frontend typechecks/builds and icons; explicitly skips Rust | Node only |
| `npm test` | Fast offline Node regression tests | Installed root npm dependencies |
| `npm run check` | Desktop TypeScript check | Installed root npm dependencies |
| `npm run build -- --bundles msi` | Release Windows MSI, including generated resources | Windows and its Tauri prerequisites |

Verification stops at the first failed step and returns a failing exit code. It
does not install dependencies, change versions or publish a release. It invokes
`before:build` to generate `resources/overlay_server/` and `src-tauri/icons/` before
native checks, preventing the missing-resource errors produced by checking a
fresh Tauri checkout directly.

`.github/workflows/verify.yml` runs `verify --desktop` on Windows and builds/uploads
the MSI. `.github/workflows/main.yml` runs the same normal verification before
each platform's release build. A local Linux/macOS result does not replace the
Windows installer check. OAuth, a real live broadcast and OBS rendering still
need a manual smoke test; fixtures do not claim to validate live API availability.

## Message flow and ownership

The desktop app owns platform connections. Widget assignments are resolved by
`src/helpers/accountRouting.ts`; explicit assignments take priority over defaults.
An account requiring reauthorization must not silently use a different account.
Each read account has one active reader, regardless of the number of layouts.

| Stage | Twitch | YouTube | TikTok |
| --- | --- | --- | --- |
| Account lifecycle | `src/hooks/useTwitchWebsocket.ts` | `src/hooks/useYouTubeChat.ts` | `src/hooks/useTikTokChat.ts` |
| Transport/recovery | `src/helpers/services/twitch/twitchSession.ts` | `src/helpers/services/youtube/youtubeChatReader.ts`, `src/helpers/services/youtube/youtubeStream.ts`; `src-tauri/src/youtube.rs`, `src-tauri/youtube-stream/` | `src-tauri/src/tiktok.rs`, `src-tauri/src/session_tasks.rs` |
| Provider event handling | EventSub notifications | `src/helpers/services/youtube/youtubeTypes.ts` and reader batch/deduplication logic | `src/helpers/services/tiktok/tiktokEvents.ts` parses Euler bundles and normalizes supported chat events |
| Widget envelope | `twitch-event` | `youtube-event` | `tiktok-event` |

All three converge on `src/helpers/widgetMessage.ts`. It sends each assigned widget
an envelope through the native WebSocket server and dispatches a local event for
bot widgets. The envelope carries the event ID/type, timestamp, account ID and
provider payload. The overlay host in
`src-overlay/src/hooks/useSlime2Websocket.ts` exposes `slime2:*` events to widget
scripts. Rendering, retention, animations and villager selection belong to those
scripts. `resources/widgets/slime2_overlay_chat_box/script.js` is the built-in chat
widget; separately installed Villager Chat is not part of Desktop's source tree.

### Authentication and native command boundaries

- `src/helpers/json/accounts.ts` separates account metadata from stored tokens.
  `src-tauri/src/secret.rs` owns OS credential-store access.
- `src-tauri/src/commands/credentials.rs` exposes the existing credential commands.
- `src-tauri/src/commands/youtube_oauth.rs` handles the loopback PKCE callback and
  Google code exchange/refresh. OAuth inputs are entered at runtime; building
  the app does not require Google credentials. Keep the URL serializer out of
  scope before `.await` so the future remains `Send` for Tauri.
- `src-tauri/src/commands/tiktok.rs` exposes start/stop/lookup entry points while
  keeping Euler credentials native. Its transport remains in `src-tauri/src/tiktok.rs`.
- Widget/file/font commands remain in `src-tauri/src/commands.rs`. Further moves
  should group related behavior and keep public invoke signatures unchanged.
- `src/helpers/commands.ts` is the frontend command wrapper;
  `src-tauri/src/main.rs` registers commands by their qualified module paths.
  JavaScript continues to invoke the original function names.

Twitch and YouTube refresh logic lives in their respective `*Auth.ts` services.
Temporary outages preserve credentials; only confirmed credential rejection
should require reauthorization. Use existing account/session ownership checks
when stopping or replacing readers so stale tasks cannot cancel new connections.

### Recovery and resource limits

Twitch uses EventSub welcome/keepalive deadlines, transfers to a replacement socket
on a reconnect request, and suppresses replayed notifications. The app's local
widget WebSocket has its own heartbeat and bounded outgoing queues; it is separate
from the upstream platform connection. Pending widget requests are rejected on
disconnect, and registration completes before new requests are released.

YouTube prefers `streamList` gRPC. Its established stream has no chat-inactivity
timeout. After three transport failures (or an unsupported endpoint), the reader
uses REST for ten minutes, with at least 30 seconds between polls and any longer
server interval honored. It then retries streaming. Successful dispatch commits
the continuation token; replay deduplication allows updates such as gift combos,
polls and tombstones. Discovery and quota pauses are handled separately. Streaming
reduces polling; it does not bypass the YouTube Data API's quotas.

TikTok uses Euler Stream, not a public TikTok chat API. Native keepalive detects
dead connections while allowing quiet chat. Offline and general reconnect delays
are currently five minutes (`OFFLINE_RETRY_DELAY` and `ERROR_RETRY_DELAY` in
`src-tauri/src/tiktok.rs`). TikTok normalization forwards chat/emotes and final
gift streaks. Widgets decide which normalized event types they render.

See [CONNECTION-RECOVERY.md](CONNECTION-RECOVERY.md) for TLS initialization,
TikTok reader panic recovery and YouTube EOF/readiness diagnostic codes.

## Shared state, account linking and emotes

`src/hooks/useWidgetRequest.ts` validates and routes widget requests. Generic
shared storage is implemented in `src/helpers/json/widgetSharedStorage.ts` and
native atomic JSON writes in `src-tauri/src/file.rs`. Persistent data lives below
Tauri's **app config directory**, at
`config/widget_storage/ns-<encoded-namespace>.json`; session scope is memory-only.
The path is generated by the app, never supplied by a widget. Widgets with the
same declared namespace share state. This is cooperation between installed
widgets, not an isolation boundary.

Use compare-and-set revisions for read/modify/write, consistent operation IDs for
duplicate chat commands, and refresh shared values after reconnect. Do not edit
the on-disk store while the app is running. See [shared-widget-storage.md](shared-widget-storage.md)
for request shapes and limits.

`src/helpers/services/platformUserLookup.ts` resolves exact usernames/handles to
stable string IDs, with shared lookup caching, deadlines and request limits.
`src-tauri/src/tiktok_lookup.rs` handles native Euler lookup. The widget implements
`!linkAccount`, moderator checks, ownership-conflict policy and the schema saved
in shared storage. Desktop does not know about villagers or identity-link policy.
See [platform-user-lookup.md](platform-user-lookup.md) for the generic request API.

Emote services live under `src/helpers/services/emotes/`. In particular,
`src/helpers/services/emotes/YouTube.ts` contains the retained best-effort global
shortcode catalog; it is not a fresh catalog downloaded from YouTube's Data API.
Provider emote caches and in-flight requests are shared in the app. The widget
chooses animated/static images and handles unknown shortcode rendering.

## Offline fixtures and regression tests

`tests/fixtures/` contains invented Twitch EventSub frames, YouTube API-shaped
messages and Euler chat bundles. There are no tokens, real user records or
downloaded emote assets. `tests/helpers/fixtures.mjs` returns a fresh parsed copy.
These files can be reused by a separate widget project's harness without adding
that widget as a Desktop dependency.

- `tests/message-fixtures.test.mjs` checks provider data/emote preservation through
  widget/bot routing and TikTok Unicode/emote normalization.
- `tests/production-hardening.test.mjs` uses Twitch reconnect/replay fixtures and
  verifies credential safety, account routing and concurrent widget registration.
- `tests/youtube-streamlist.test.mjs` exercises quiet connections, reconnect,
  replay, continuation, quota pauses, REST intervals and native cancellation.
- Storage, lookup and overlay request tests cover conflicting writes, three
  layouts, failed saves, stale responses and pending-request cleanup.
- `src-tauri/native-tests/` imports actual production Rust transport modules;
  `src-tauri/youtube-stream/` tests protocol conversion and streaming behavior.
- `tests/version-tooling.test.mjs` verifies version edits preserve lockfile
  dependencies/line endings and reject malformed or concurrently edited files.

To reproduce a new bug, add a minimal invented payload and exercise the production
handler with mocked network/clock boundaries. Keep IDs as strings, especially
TikTok's 64-bit IDs. Use `.invalid` for image URLs and never contact providers
from an offline fixture test. Render/animation regressions still require the
widget's browser harness or an OBS test.

## Versions, logs and patch delivery

```sh
npm run version:check
npm run version:set -- 1.5.1 --dry-run
npm run version:set -- 1.5.1
```

The version tool updates the root and overlay `package.json`, both corresponding
lockfile root versions, the `slime2` package in `src-tauri/Cargo.toml` and
`src-tauri/Cargo.lock`, and `pkgbuild/PKGBUILD`. Tauri continues reading
`../package.json`. The helper crates and widget versions remain independent.
Only stable [MSI-compatible numeric versions](https://learn.microsoft.com/en-us/windows/win32/msi/productversion) are accepted; release workflows add
their channel suffixes. The script does not update dependencies, commit or tag.
It validates all inputs first, stages replacements and attempts rollback on a
failed write; this is not a transaction across the filesystem. Review the diff.

At startup the normal Slime2 log records app version, full Git commit, source
state (`clean`, `modified` or `unknown`), target and build profile. Git is queried
at build time by `src-tauri/build_metadata.rs`. A source archive without Git uses
a valid `GITHUB_SHA` if provided, otherwise `unknown`. This is diagnostic
provenance, not a signature or proof of source integrity. Normal source edits and
Git revision changes refresh the metadata on the next build.

`src/hooks/useWidgetRegistration.ts` records each connected widget's tile name, widget ID, widget name and version,
including when tile/widget names match. These records use the existing Slime2
text log through `src/main.tsx` and `src/helpers/safeLog.ts`. Include the startup
header, relevant connection lines and nearby errors in bug reports. Do not add
full provider payloads, HTTP headers, credentials or authenticated overlay URLs.

For a patch, record `git rev-parse HEAD` and the target branch, include new files,
run verification and `git diff --check`, then confirm `git apply --check` in a
clean checkout of the base. Generated bundles, icons, node_modules, targets and
local logs are not source changes. Build/release validation belongs to the host
platform; do not describe an unrun Windows MSI or live-account test as passed.
