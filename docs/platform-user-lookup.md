# Moderator username lookup

Apply `slime2-link-account-usernames.patch` from the repository root after the
previous chat recovery/streamList patches. Villager Chat's shared-storage and
compare-and-set patches remain prerequisites for saving account links. This
incremental patch adds username resolution; it does not repeat those changes.

```powershell
git apply --check .\slime2-link-account-usernames.patch
git apply .\slime2-link-account-usernames.patch
node --test tests/*.test.mjs
npm run build
```

Run the rebuilt Desktop app and update all three Villager Chat layouts using
`Villager-Chat-Horizontal-Slime2-Desktop-2.1.5-desktop.9.zip`. Keep the existing
widget settings and storage namespace. The update preserves the shared villager
choices; it does not require clearing the database. The app does not include or
depend on Villager Chat: its new lookup request is available to other widgets.

A moderator or broadcaster in the widget's assigned Twitch channel can run:

```text
!linkAccount jack twitch:maskarauder youtube:@Maskarauder tiktok:maskarauder
```

Replace each handle with the account you intend to associate. Include one or
more accounts; omit unused platforms. YouTube requires the unique handle, not
the channel's display name. Usernames are resolved to stable IDs before the
existing atomic shared-storage update. All supplied accounts must resolve and
pass the ownership-conflict check; otherwise the mapping is unchanged. Three
layouts share in-flight lookups and successful results for one minute.

An assigned, connected read account is required for each platform being looked
up. Twitch and YouTube use that account's existing OAuth credentials. TikTok
uses the Euler Stream API key already stored by Slime2, through the documented
user-ID endpoint. Access to that endpoint depends on the key's permissions and
service limits. A denied lookup reports a useful error in Slime2's log; it does
not silently link by nickname. Lookups still consume the providers' API quota.

Existing numeric Twitch/TikTok IDs and `UC...` YouTube channel IDs still work
without a network lookup. Explicit `twitch:id:123`, `youtube:id:UC...` and
`tiktok:id:123` forms are also accepted. For an all-numeric *username*, use `@`,
such as `twitch:@12345`, to distinguish it from a user ID. These explicit IDs
are format-checked, not verified against the provider. Manual legacy login
rows are preserved; migrate those rows to IDs to avoid duplicate identities.

This is a streamer-managed association. It does not verify account ownership
or grant moderation privileges. Only subsequent messages use a changed mapping.

## Generic Desktop widget request

```js
const user = await slime2.request('resolve-platform-user', {
  account_id: assignedReadAccount.id,
  platform: 'youtube', // twitch | youtube | tiktok
  username: '@Maskarauder',
})
// { platform: 'youtube', id: 'UC...', username: 'maskarauder' }
```

The app validates that this read account is assigned to the widget, resolves
an exact username/handle and returns only its platform, username and ID. Twitch
and YouTube calls stay in the app; the Euler key stays in native Rust. Tokens,
provider request headers, and raw provider error bodies are never returned by
this lookup request. Existing credential logging elsewhere is a separate issue
identified in the production-readiness review.

Requests have a 20-second application deadline (15 seconds for native Euler
HTTP), a maximum of 16 simultaneous lookups and 60 uncached lookups per minute
across the application. Success entries expire after 60 seconds, errors after
5 seconds, and the cache is capped at 256 entries. Account assignment is checked
before using even a cached result. Unknown or ambiguous results are rejected.

## Relative project paths

- `src/helpers/services/platformUserLookup.ts`: authorization, resolution,
  coalescing, timeouts, rate limits and safe error messages.
- `src/helpers/services/twitch/twitchApi.ts`: exact login lookup.
- `src/helpers/services/youtube/youtubeApi.ts`: `channels.list(forHandle=...)`.
- `src/helpers/commands.ts`, `src-tauri/src/commands.rs`,
  `src-tauri/src/tiktok_lookup.rs`, `src-tauri/src/main.rs`: native Euler lookup.
- `src/hooks/useWidgetRequest.ts`: generic widget request schema and handler.
- `tests/platform-user-lookup.test.mjs`: resolver regression tests.
- In the ZIP: `widget.js`, generated `script.js`, `config/settings.json`,
  `config/meta.json`, and `README.txt`.

## API references

- [Twitch Get Users](https://dev.twitch.tv/docs/api/reference/#get-users)
- [YouTube channels.list](https://developers.google.com/youtube/v3/docs/channels/list)
- [Euler Stream Retrieve Webcast user ID](https://www.eulerstream.com/docs/api/tiktok-live-anchors#retrieve-webcast-user-id)
- [Euler Stream first-party API SDK](https://github.com/EulerStream/TikTok-Live-Api)

## Validation limits

Automated app tests and a three-layout browser simulation cover exact lookup,
deduplication, moderator checks, no partial updates, conflicts, numeric usernames,
shared choices, a 100-message burst and persistence errors. Provider responses
are mocked; live credentials are not used. The TypeScript check and frontend
production build are checked separately. A fresh Rust/Windows build and live
OAuth/Euler smoke test are still required; this environment has no Rust compiler.
