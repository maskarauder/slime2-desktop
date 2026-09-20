# Offline chat fixtures

These are synthetic examples, not recordings from real accounts or credentials.
Image URLs use `example.invalid` and must not be fetched by tests. The Twitch
reconnect URL uses Twitch's expected public host so host validation still runs;
the WebSocket itself is always mocked.

| File | Cases | Consumers |
| --- | --- | --- |
| `twitch.json` | Welcome/reconnect/resume, text/emote, membership, gifts, deletion | Message routing and Twitch session tests |
| `youtube.json` | Shortcode text, Super Chat/sticker, memberships/gifts, deletion | Message routing and reader replay tests |
| `tiktok.json` | Euler bundle, Unicode text, inline emote, large string IDs, unsupported gift and malformed-author cases | Actual Euler parser/normalizer and routing tests |

Load with `fixture('twitch')` from `tests/helpers/fixtures.mjs` to receive an
independent copy. For a new regression, add the smallest representative payload
and assert behavior in the production handler. Do not change a fixture merely to
make a failing test pass without checking the provider contract. The Euler gift
example is an explicit ignored-event case, not an assertion of gift support.
