# Working on Slime2 Desktop

Read `docs/DEVELOPMENT.md` for architecture, validation and release steps.
Keep changes scoped to the request and preserve work already in the checkout.

## Project map

- `src/`: React desktop UI, account readers, provider services and widget routing.
- `src-tauri/src/`: native commands, credentials, local HTTP/WebSocket server,
  file access and TikTok/YouTube transport lifetimes.
- `src-tauri/src/commands/`: OAuth, credential and TikTok command entry points.
- `src-tauri/youtube-stream/`: gRPC client, pinned protocol and transport tests.
- `src-tauri/native-tests/`: tests importing production Rust modules without Tauri.
- `src-overlay/`: browser-source host and widget request/reconnection bridge.
- `resources/widgets/`: built-in widgets; their versions are independent of the app.
- `tests/`: Node regression tests; `tests/fixtures/` contains synthetic chat events.
- `scripts/`: verification and version tooling.

## Commands from the repository root

- Install exactly the committed dependencies: `npm run setup`.
- Develop: `npm start`.
- Normal verification: `npm run verify` (Node tests, both frontend builds and
  typechecks, headless Rust transport/gRPC tests).
- Full native verification: `npm run verify -- --desktop` (requires Tauri OS
  prerequisites; Windows CI runs this before building an MSI).
- Frontend-only environment: `npm run verify -- --web-only`; report the Rust
  checks as omitted, not passed.
- Set app version: `npm run version:set -- 1.5.1`; inspect first with `--dry-run`.
- Windows installer: `npm run build -- --bundles msi`.

Use focused tests while iterating, then the shared verification command. Report
the actual commands/results and any platform or live-service checks not run.

## Boundaries and invariants

- Keep Villager Chat and its commands, artwork, account-mapping policy and data
  schema in its own widget project. Desktop exposes generic shared storage,
  platform lookup and event APIs; it must not import or special-case that widget.
- One reader per assigned account fans out to widgets. Additional browser
  sources must not create additional provider chat readers.
- Keep abort/session ownership checks, bounded queues, pending-request cleanup,
  deduplication and reconnect/keepalive behavior intact. Quiet chat is normal.
- Keep YouTube REST fallback at least 30 seconds apart and respect larger server
  intervals. Streaming still uses the YouTube Data API and its limits.
- Credentials belong in the OS credential store. Use existing safe log/error
  helpers; do not log headers, tokens, secrets, complete HTTP errors or overlay
  access URLs. Fixtures must contain invented data and no credentials.
- Preserve platform IDs as strings. Shared storage uses app-owned paths,
  serialization, revisions and duplicate operation IDs; retain its generic API.
- Moving a Tauri command must preserve its invoke name, arguments and return
  shape. Update its qualified registration in `src-tauri/src/main.rs`.
- Do not regenerate dependencies or run `cargo update` for setup or version
  changes. Keep both npm lockfiles and all Cargo lockfiles committed. In
  particular, preserve nested TypeScript peer entries needed by `npm ci`.
- Use existing formatting on edited code and avoid unrelated reformatting.
  Document behavior/API changes and add regression coverage for substantive fixes.

## Delivering patches

Record the base commit and intended branch. Include new files, check whitespace,
and verify the patch applies to a clean checkout of that base. Do not include
generated icons, overlay bundles, build outputs, local credentials or logs.
