# Slime2 - https://slime2.stream/

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/V7V14PTBF)

## Setup

Slime2 is a desktop app for Linux, Windows, and macOS built using Tauri, Vite, React, and TypeScript.

Here is what you need to run the app in development mode:

1. Install the Tauri prerequisites: https://tauri.app/start/prerequisites/
    - Just need the system dependencies, Rust, and Node.js; this is not built for mobile so skip the mobile configuration.
    - For Linux, will also need to install GStreamer.
        - Fedora/Ubuntu/Debian instructions: https://gstreamer.freedesktop.org/documentation/installing/on-linux.html?gi-language=c
        - Arch Linux instructions: https://wiki.archlinux.org/title/GStreamer (install all of the common package set)
2. Run `npm install` to install the base Node dependencies.
3. `cd src-tauri` to enter the backend folder, and run `cargo update` to install the Rust dependencies.
4. `cd ../src-overlay` to enter the overlay server folder, and run `npm install` to install the overlay server's Node dependencies.
5. `cd ..` to return to the project root.
6. `npm start` to start development mode.
    - Sometimes this fails and it shows being unable to delete something as part of the pre-start cleanup; usually you can just run it again and it'll work. Also make sure you don't already have the app running.

> When updating built-in widgets in `/resources/widgets`, you will need to close the app and run `npm start` again, since it only sets the `resources` folder upon initialization. Also, the widgets won't auto update, you will need to install a fresh version of the updated widget on a new tile.

> If you're using VS Code, it will auto suggest useful extends from [extensions.json](.vscode/extensions.json) and [settings.json](.vscode/settings.json) in the `.vscode` folder.

## YouTube live chat setup

YouTube chat uses Google's installed-app OAuth flow and needs a Google Cloud
Desktop app client ID and client secret for your fork:

1. Create or select a Google Cloud project and enable the
   [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
2. Configure the OAuth consent screen. If the app is in testing mode, add the
   Google account that owns the YouTube channel as a test user.
3. On the [Google Auth clients](https://console.cloud.google.com/auth/clients)
   page, create an OAuth client with application type **Desktop app**.
4. In Slime2, add a **Read Account**, choose YouTube, paste the client ID and
   client secret, and finish authorization in the system browser. The secret is
   stored with the account tokens in the operating system credential store.
5. Install or update the Slime2 Chat Box to version 1.6.0 or newer, then select
   the YouTube read account in its YouTube account slot (or make that account
   the default).

The current integration reads the authenticated channel's active live chat. It
does not send YouTube chat messages.

## Live-chat recovery

The chat readers continue polling while a chat is quiet. YouTube requests have
a 30-second deadline; a temporary network failure retries with backoff while
keeping the current live-chat page token. Saved YouTube credentials are kept
when a refresh attempt times out or Google returns a temporary server, rate
limit, or network error. The account is marked for reconnection only when
Google rejects the credentials themselves, such as `invalid_grant` or
`invalid_client`.

TikTok LIVE connections have a 30-second connection deadline. After 30 seconds
without a WebSocket frame, Slime2 sends a protocol ping and waits 15 seconds
for a response. A dead connection is closed and retried; normal quiet chat is
left connected. Euler Stream's offline and no-message close codes are logged
as reconnectable status events.

The recovery code logs the account name, retry delay, safe HTTP status/reason,
and recovery event. It never logs OAuth headers, access tokens, refresh tokens,
or API keys. Rebuild Slime2 after applying the patch; existing account and
widget settings do not need to be recreated.

## Experimental TikTok LIVE chat setup

TikTok does not provide an official public API for reading LIVE chat. This fork
therefore connects through the third-party
[Euler Stream](https://www.eulerstream.com/) WebSocket gateway. The integration
is read-only and does not ask for a TikTok password or session cookie, but it may
need updates when TikTok changes its internal LIVE service.

1. Create an Euler Stream account and API key. Service limits and pricing are
   controlled by Euler Stream.
2. In Slime2, add a **Read Account**, choose **TikTok LIVE (Experimental)**,
   and enter the broadcaster's public username plus your Euler Stream API key.
3. Install or update the Slime2 Chat Box to version 1.7.0 or newer, then select
   the TikTok read account in its TikTok account slot (or make it the default).

Slime2 stores the Euler Stream key in the operating system credential store,
connects from the Tauri backend, and automatically retries while the broadcaster
is offline. TikTok chat sending and 7TV/BTTV/FFZ emotes are not supported for
TikTok; native TikTok chat emotes are rendered when the gateway includes them.
