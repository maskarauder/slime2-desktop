# Twitch GIF messages

Twitch EventSub `channel.chat.message` can include this fragment:

```json
{
  "type": "gif",
  "text": "[GIF description]",
  "gif": {
    "id": "provider-gif-id",
    "url": "https://media.example.invalid/example.gif?provider=example"
  }
}
```

The surrounding `message_type` remains `text`. The exact asset URL is forwarded
and rendered, including its query parameters. No URL reconstruction, Giphy lookup,
new Twitch subscription, OAuth scope or extra chat reader is needed. Ordinary
pasted image URLs remain text. The URL above is an offline fixture, not a live GIF.

Source: [Twitch EventSub reference](https://dev.twitch.tv/docs/eventsub/eventsub-reference/#channel-chat-message-event).

## Rendering and testing

The built-in Slime2 Chat Box (1.7.2) and companion Villager Chat
(2.1.5-desktop.12) display at most one GIF image per message, preserving its aspect
ratio inside 280×160 pixels. Additional GIF fragments use their descriptions.
Missing, invalid and failed image URLs fall back to the description. Only HTTPS
URLs without embedded credentials are accepted. GIFs use the normal message
retention, expiration and moderation paths; image sources are cleared on removal.
Delayed messages do not begin loading GIFs until displayed.

Enable the widget's existing **Static emotes** option to show descriptions and
avoid GIF downloads. Enabling it also stops displayed GIFs. Turning it off applies
to incoming messages; reload the source to clear previous descriptions. Static
rendition URLs are not invented because Twitch supplies only the original URL.
The built-in widget also limits image waits to five seconds, so a broken image
cannot hold a chat message indefinitely.

Event Simulator > Cross-platform chat test > Twitch > GIF message sends a
synthetic event with the repository's existing small GIF sample. The sample URL
is pinned to a commit. This needs no live account or chat API request, but fetching
the image requires network access. The mock event does not invoke bot commands.

The three browser sources still decode their own displayed GIFs. Bounded display
size is not a bound on the source file's decoded memory. Keep a low message limit
(default 3 in Villager Chat), or enable Static emotes for lower resource usage.
CSS badge/bubble animation limits do not pause animated GIF image decoding.

## Files and installation

All paths below are relative to the repository root:

- `src/@types/twitch.d.ts`: GIF fragment metadata.
- `src/helpers/simulator.ts`, `src/pages/simulator/PlatformSimulator.tsx`: preview.
- `resources/widgets/slime2_overlay_chat_box/`: built-in renderer/settings.
- `tests/fixtures/twitch.json`: invented GIF-only and mixed-content payloads.
- `tests/message-fixtures.test.mjs`, `tests/product-tools.test.mjs`,
  `tests/builtin-twitch-gif.test.mjs`: routing, simulation and renderer regressions.

The incremental `slime2-twitch-gif.patch` applies to `main` at
`81c8ed9a4d75ef523aa365befada3181d4edc1f4` **after** the previously delivered
`slime2-desktop-tools.patch`. Apply with `git apply --check` then `git apply`,
run `npm run verify`, and rebuild the app. Update installed built-in Chat Box
copies to the bundled 1.7.2 files while retaining their settings.

Villager Chat remains a separate widget. Update each existing layout's core
using its ZIP's `README.txt` instructions to retain widget IDs/settings. Its live
GIF rendering also works with the previous app, which already forwards raw
EventSub fragments; the app patch adds typing, simulation and built-in rendering.
