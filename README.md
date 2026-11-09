# MG3 Creator Live Alerts — Fresh Bot (Complete Project)

This is a **brand-new Discord bot project**, with **no creators preconfigured, no saved alerts, no tokens, and no imported settings**. It is ready for Bot-Hosting.net and uses the startup file `src/index.js`. It is based on the tested V6 codebase but is packaged as a fresh install.

## Quick start on Bot-Hosting.net

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create your new bot. Under **Bot**, copy the bot token securely. Enable application installation with `bot` and `applications.commands`. Invite the bot to your server with **View Channels**, **Send Messages**, **Embed Links**, and **Mention Everyone** only if you want pings. Do **not** give it Administrator permissions.
2. Upload/extract the **contents** of this ZIP into an empty Bot-Hosting server. At the root you should see `package.json`, `src/`, `scripts/`, `.env.example`, and `README.md`. Do not put the files inside an extra project folder.
3. Select Node.js 24 (or Node.js 22.12+), run `npm install`, and set the startup file to **`src/index.js`**, or run `npm start`.
4. Set the following Bot-Hosting private environment variables:
   - `DISCORD_TOKEN` — new Discord bot token **required**.
   - `GUILD_ID` — your Discord server ID (recommended for instant `/alerts` registration).
   - `YOUTUBE_API_KEY` — YouTube Data API v3 key for YouTube.
   - `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` — Twitch developer application credentials.
   - `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET` — Kick developer application credentials.
   - `TIKTOK_SIGN_API_KEY` — **optional** signing key for TikTok LIVE checks if they get rate limited.
   - `APIFY_TOKEN` — **optional** for TikTok public posts; can cost money and fail on restricted accounts.
5. Start the bot. Watch for `Logged in as` and `Registered /alerts` in the console.
6. Use `/alerts add platform:youtube creator:@example channel:#notifications notify:both` (repeat for other creators/platforms). The first automatic check records existing streams/videos rather than re-announcing old content.
7. Use `/alerts list`, `/alerts status`, `/alerts check` (does not post), and `/alerts test` (only sends content that has not previously been handled).

You **do not need** any previous `data/alerts.json` file. The `data/` directory begins empty. The bot writes persistent subscriptions and dedupe IDs to `data/alerts.json` after you add creators. Keep this directory for future restarts/backups.

## Platforms, speed, and constraints

| Platform | Content | Without a public HTTPS webhook URL | Faster optional method |
|---|---|---|---|
| YouTube | Public videos | Playlist checks ~60 sec for a small number of creators, slower with many | WebSub push with HTTPS receiver |
| YouTube | LIVE | Active streams in playlist when available; fallback API search quota schedule (~16 minutes per one creator) | WebSub can trigger targeted verification; not a guaranteed LIVE event |
| Twitch | LIVE | ~30 sec checks | Twitch EventSub **outbound WebSocket** or HTTPS webhook |
| Kick | LIVE | ~30 sec checks | Kick HTTPS webhook |
| TikTok | LIVE | ~60 sec best-effort checks | No reliable public push notifications for arbitrary creators |
| TikTok | Public posts | Best-effort feed; Apify cache defaults to 6 hr if configured | No unrestricted, guaranteed instant method |

Intervals are **targets, not guarantees**. Restricted creator accounts may be inaccessible. Apify may charge for requests; the TikTok fallback does not bypass audience controls or privacy restrictions. Never use multiple Google Cloud projects solely to circumvent quota policies.

## Creator notification rules

- **Priority: stream first.** If the creator is LIVE, send the stream only if its ID has never been handled for that destination. Do not send a video during a live check.
- If not LIVE and the latest public video is new, announce **only that newest video**. If it was handled, **send nothing**. Older unseen videos are not replayed.
- Stream/video IDs are persisted in `data/alerts.json` and reused after restart. `/alerts test` respects this history and reports **Nothing new** when appropriate.
- This works per tracked creator/destination. Run only **one bot instance using the same data directory** to avoid duplicate notifications.
- Customize live messages with `/alerts message`, upload messages with `/alerts video_message`; pings via `/alerts ping` and `/alerts video_ping`. Manage Server permission is required for commands.

## Optional near-real-time connections

### Twitch EventSub WebSocket, without an incoming port

Twitch EventSub WebSocket needs a **user** OAuth token, not only the client ID/secret. Set Twitch variables, then run `npm run twitch:auth` once in your Bot-Hosting environment (if there is no interactive console, temporarily switch startup command to `node scripts/twitch-device-auth.js` then restore `npm start`). Authorize using the code shown in the console. The token is saved in private `data/twitch-oauth.json`. Restart normally. The bot uses the WebSocket for up to 10 Twitch creators per token, and continues checking other creators on a timer. Never commit `data/` to GitHub.

### YouTube WebSub, Twitch webhook, and Kick webhook

These require an **actual public HTTPS endpoint** that forwards to the bot's `PORT` (default 3000). Only set `PUBLIC_BASE_URL` when one exists. Setting a fake URL does not create a webhook. Add `YOUTUBE_HUB_SECRET` and `TWITCH_WEBHOOK_SECRET` as long random values if using those webhooks, and configure Kick's callback in the Kick developer portal. The bot's receiver supports `GET /health`, `/webhooks/youtube`, `/webhooks/twitch`, and `/webhooks/kick`. Validate subscription acceptance and event delivery through provider dashboards.

When no public HTTPS address is available on Bot-Hosting, **leave `PUBLIC_BASE_URL` blank**. Normal polling still works, and Twitch outbound EventSub can work independently.

### YouTube quota

YouTube `search.list` requests have a low default daily cap (commonly 100 Search Queries/day); this project targets ~90/day across watched channels. `playlistItems.list` and `videos.list` use separate, lower-cost read quota. Additional manual tests, other API clients, or restarts can still exhaust quotas. Google resets quotas at midnight US Pacific time. Increasing the number of creators lengthens the search fallback interval.

### TikTok posts

The bot first tries public data sources. If `APIFY_TOKEN` is configured, it runs a TikTok profile scraper at the `TIKTOK_APIFY_INTERVAL_MINUTES` interval (minimum 30 minutes), including caching failed requests to limit charges. Scraping can return **empty results**, HTTP 403, or error on audience-restricted profiles. For those profiles the bot cannot reliably announce posts. Do not leave paid scraping enabled on profiles it cannot read.

## Files

```text
package.json              Bot dependencies, npm scripts
Dockerfile                Optional Docker deployment
.env.example              Blank variables template (never put real secrets in GitHub)
README.md                 This guide
QUICK-START.txt           Short Bot-Hosting steps
src/index.js              Entry point, Discord slash registration
src/commands.js           /alerts slash commands and dashboard
src/platforms.js          YouTube/Twitch/Kick/TikTok API checks
src/monitor.js            Schedules, stream-first logic, de-duplication
src/tiktok-apify.js       Optional Apify fallback
src/twitch-ws.js          Optional Twitch EventSub WebSocket
src/events.js             Optional HTTPS webhooks
src/store.js              Private persistent data
src/template.js           Notification text/pings
src/uploads.js            Upload helpers
scripts/twitch-device-auth.js    One-time Twitch OAuth
test/*.test.js            Offline tests
data/.gitkeep             Empty data directory, NO settings
```

## Troubleshooting

- `Missing Access` (Discord 50001): bot not invited to the `GUILD_ID` server or missing bot/application.commands installation.
- `YouTube Search Queries quota exceeded`: search allowance depleted; scheduled searches resume after quota resets, but lowering frequency or switching to WebSub is the sustainable solution.
- `TikTok 403`, `processInitialData`, or empty Apify dataset: unofficial provider failure/restriction; no guarantee of an accessible public feed.
- YouTube creator rejected: add it with a `youtube.com/@handle` or `youtube.com/channel/UC...` link (legacy `/user/Name` links also work). `/c/Name`, video and `youtu.be` links are refused on purpose because they can point to the wrong channel.
- `npm install` says no matching version: loosen the version of the named package in `package.json`, for example `"tiktok-live-connector": "latest"`.
- `npm run twitch:auth` fails: in the Twitch developer console set your application's Client Type to **Public**, then try again.
- `data/alerts.json` damaged: the bot restores `data/alerts.json.bak` automatically, or keeps the damaged file as `alerts.json.corrupt-<time>` and starts empty. Back up `data/` now and then.
- Twitch/Kick `401`: verify platform API keys and secrets.
- Notifications not sending: bot needs Send Messages and Embed Links in the target channel.
- Node.js errors: make sure Node 24 and `npm install` completed, check the console.

Local tests check JavaScript state and mocked provider interactions; they do not prove that external APIs or Bot-Hosting network access are currently working.
