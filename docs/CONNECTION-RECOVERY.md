# TikTok TLS and YouTube stream diagnostics

Base: `main` at `529224540589492e4121f650b9136dcddf858f37` (Slime2 1.5.0).
These changes require a rebuilt desktop app. No widget update is required.

## TikTok

The dependencies enable both rustls crypto providers: reqwest enables AWS-LC
and the YouTube client enables ring. TikTok's automatic TLS provider selection
can panic in this configuration. An unobserved reader panic after reporting
`connecting` could leave that state indefinitely. The supplied diagnostic is
consistent with this path, but does not contain a captured panic proving it.

`src-tauri/src/tls.rs` now installs a provider at the start of `main`, before
native clients are created, and preserves any previously installed provider.
The native tests deliberately enable both providers and check default TLS
configuration. Cargo changes retain the already locked dependency versions.

Unexpected TikTok reader panics now produce a fixed, credential-free Slime2 log
entry and a reconnecting status, followed by a five-minute retry. Stopping or
replacing the account cancels the reader and pending retry together. Rust's
existing panic hook may still write to stderr; its payload is not copied into
the new Slime2 log entry. Connection attempts are logged, and ordinary failures
distinguish TLS, network I/O, HTTP rejection and protocol negotiation without
printing authenticated URLs or upstream response bodies.

## YouTube

Slime2 previously invented `GRPC_14` when the native stream returned a clean EOF,
and logged `connected` before receiving a response. The endpoint, RPC,
authentication and protobuf fields match Google's
[Streaming Live Chat guide](https://developers.google.com/youtube/v3/live/streaming-live-chat).
No request/protocol change is justified by the evidence, and this patch does
not claim to prevent Google from closing an empty stream.

The connection becomes ready on its first response batch; a valid empty batch
counts. A quiet established stream still has no application inactivity timeout.

| Diagnostic code | Meaning |
| --- | --- |
| `STREAM_EMPTY_EOF` | Clean end before any response batch. |
| `STREAM_EOF` | Clean end after at least one response batch. |
| `GRPC_<number>` | Actual native gRPC error, with its code preserved. |
| `NATIVE_STREAM_ERROR` | Native command failure without a structured gRPC error. |

EOF diagnostics include elapsed milliseconds, batch count and continuation
presence, never the continuation/OAuth token. After three stream failures,
REST fallback still polls at least 30 seconds apart, honors larger server
intervals, and retries gRPC after ten minutes. OAuth refresh, quota pauses,
continuation, deduplication and cancellation behavior are preserved.

## Changed source paths

- `src-tauri/src/tls.rs`, `src-tauri/src/main.rs`: TLS initialization.
- `src-tauri/src/session_tasks.rs`, `src-tauri/src/tiktok.rs`: reader recovery.
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`: explicit rustls dependency.
- `src-tauri/native-tests/`: mixed-provider and reader lifecycle tests.
- `src/helpers/services/youtube/youtubeStream.ts`,
  `src/helpers/services/youtube/youtubeError.ts`,
  `src/helpers/services/youtube/youtubeChatReader.ts`: accurate status/errors.
- `tests/youtube-streamlist.test.mjs`,
  `src-tauri/youtube-stream/src/tests.rs`: IPC and local HTTP/2 gRPC tests.

## Validation and tester feedback

`npm run setup` and `npm run verify` use synthetic data and local test servers;
they need no TikTok account, broadcast or API key. Windows **Verify Desktop**
CI also compiles/tests the Tauri app and uploads `Slime2-Windows-MSI`.
The patch leaves the app version unchanged. Use
`npm run version:set -- <version>` when preparing the next installer release.

After installing the rebuilt app, fully restart Slime2 and export diagnostics
after testing the connection. Check for `TikTok LIVE connected` and YouTube
`streamList receiving responses`, or the new explicit failure codes. Windows
MSI installation, real Euler/Google access and OBS rendering still require
tester feedback; passing offline checks does not establish service availability.
