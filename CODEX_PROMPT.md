# Codex prompt: Time Capsule (Codex x TwitchCon Hackathon)

How to use this file:

1. Do the "Before you start" steps yourself first (about 15 minutes).
2. Open ONE Codex thread for the whole build (the hackathon asks for the session ID of the thread where most of the build happened).
3. Paste everything under "PROMPT FOR CODEX" as your first message.
4. After each phase, Codex stops and tells you how to test. Test it, then reply: `Phase N works. Continue to phase N+1.` If something is broken, paste the error and say: `Fix this before moving on.`

---

## Before you start (you do this, not Codex)

1. **Two Twitch accounts**
   - Your streamer account (the broadcaster).
   - A bot account, for example `yournameCapsuleBot`. Optional: the app can also run with only your streamer account, but then the bot talks as you.
   - Turn on 2FA on the streamer account (Twitch requires it to register apps).
2. **Register the app**: https://dev.twitch.tv/console/apps → Register Your Application
   - Name: `Time Capsule <yourname>` (must be unique)
   - OAuth Redirect URL: `http://localhost:3000/auth/callback`
   - Category: Chat Bot
   - Client type: Confidential
   - Copy the **Client ID**, click New Secret, and copy the **Client Secret**. Never paste the secret into chat or commit it.
3. **Make the bot a moderator**: in your own channel's chat, type `/mod yournameCapsuleBot` (it must be a mod to hide sealed messages).
4. **Install**: Node.js 20 LTS or newer, Git, OBS Studio. Optional for testing: Twitch CLI (https://dev.twitch.tv/docs/cli/).
5. Create an empty GitHub repo called `twitch-time-capsule` and open its folder in Codex.

---

## PROMPT FOR CODEX

You are building **Time Capsule**, a Twitch app for the Codex x TwitchCon Hackathon. Work carefully, phase by phase. After each phase: run the tests, run the app, commit with a clear message, then STOP and tell me exactly how to test that phase myself (commands, URLs, what I should see). Do not start the next phase until I say so.

### 1. What the product is

Twitch Predictions last at most 30 minutes, have fixed answers, and only cover the current stream. Time Capsule lets chat seal free-text predictions and messages that stay hidden for days or weeks, then open live on stream when a condition is met.

The flow:

1. The streamer creates a capsule in a local dashboard, for example "GTA 6 Predictions", and picks when it opens: on a date, at a follower goal, the first time they stream a chosen category (e.g. Grand Theft Auto VI), or manually.
2. Viewers type `!seal <text>` in Twitch chat. The bot immediately deletes that chat message so nobody can read it, stores it, and replies `Sealed message #214 from @user`.
3. Nothing appears on stream while the capsule waits. **The overlay must stay fully transparent and empty outside the opening ceremony.** Never distract from the game.
4. When the condition is met while the stream is live, the capsule opens automatically: an opening animation plays in the OBS overlay.
5. The streamer or a mod approves messages in a mod queue, then the overlay reveals them one by one.
6. The streamer marks predictions that came true. Those viewers become **Prophets**: the overlay stamps "CAME TRUE", the bot announces it, and (if enabled) the app grants them VIP through the Twitch API, then removes VIP after 30 days.
7. A public capsule page shows the title, the opening condition, the sealed count (never the contents) and, after opening, the revealed messages and the Wall of Prophets.

**No paid AI or external AI APIs at runtime.** The app must work with zero AI cost.

### 2. Tech stack and project rules

- Node.js 20+, TypeScript with `"strict": true`, ES modules.
- Server: Fastify (HTTP plus `@fastify/websocket` for pushing state to overlay and dashboard pages), `ws` for the Twitch EventSub WebSocket client.
- Storage: SQLite via `better-sqlite3`, file at `data/time-capsule.db`. Use migrations (a simple numbered SQL list is fine).
- Frontend: plain HTML, CSS and TypeScript or vanilla JS served by Fastify. No React. Keep pages fast and dependency-free.
- Tests: Vitest.
- Config: `.env` loaded with `dotenv`, validated at startup with `zod`. Fail fast with a clear message if anything is missing.
- Keep dependencies minimal. Explain any dependency you add.
- Works on Windows, macOS, Linux and WSL. Use `path` utilities, no shell-specific scripts.
- Scripts: `npm run dev`, `npm run build`, `npm start`, `npm test`, `npm run demo`, `npm run lint` (ESLint plus Prettier).
- License: MIT.

Folder layout (adjust if you have a good reason, and tell me):

```
src/
  server.ts            Fastify app, routes, page websockets
  config.ts            env loading + zod validation
  db/                  schema, migrations, queries
  twitch/
    auth.ts            OAuth code flow, token storage, refresh, hourly validate
    helix.ts           typed Helix API client (fetch), rate-limit aware
    eventsub.ts        EventSub WebSocket client (welcome, keepalive, reconnect, revocation)
    chat.ts            send chat messages, delete messages
  capsule/
    commands.ts        !seal, !capsule, mod commands
    triggers.ts        trigger engine (date, followers, category, manual)
    ceremony.ts        reveal state machine
    prophets.ts        came-true, VIP grant/expiry
    moderation.ts      blocked-word filter, limits
  demo/                demo mode (fake Twitch)
public/
  overlay/             OBS browser source (1920x1080, transparent)
  dashboard/           streamer dashboard + mod queue
  capsule/             public capsule page
test/
```

### 3. Twitch integration (follow these exactly)

Read the official docs when anything is unclear: https://dev.twitch.tv/docs/api/reference and https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types. Do not invent endpoints or fields.

**Accounts and tokens.** Use the OAuth authorization code flow with redirect `http://localhost:3000/auth/callback`.
- Dashboard buttons: "Connect streamer account" and "Connect bot account". Support single-account mode (bot = streamer) when no bot is connected.
- Broadcaster scopes: `channel:manage:vips moderator:read:followers moderation:read user:read:chat user:write:chat`
- Bot scopes: `user:read:chat user:write:chat moderator:manage:chat_messages`
- Use a random `state` value and verify it on callback.
- Store tokens in `data/tokens.json` (gitignored). Refresh with the refresh token on 401 or before expiry. Validate each token at startup and every hour with `GET https://id.twitch.tv/oauth2/validate`, as Twitch requires.
- Every Helix request sends `Authorization: Bearer <token>` and `Client-Id: <client id>`. Handle 429 using the `Ratelimit-Reset` header.

**EventSub over WebSocket** (`wss://eventsub.wss.twitch.tv/ws`). WebSocket subscriptions must be created with user access tokens, not app tokens.
- Open one connection per token user: a **broadcaster connection** and, if a separate bot is used, a **bot connection**. Never mix users' subscriptions on one connection.
- After the `session_welcome` message, create subscriptions within 10 seconds via `POST /helix/eventsub/subscriptions` with `transport: { method: "websocket", session_id }`.
- Broadcaster connection:
  - `stream.online` v1, condition `{ broadcaster_user_id }`
  - `stream.offline` v1, condition `{ broadcaster_user_id }`
  - `channel.update` v2, condition `{ broadcaster_user_id }`. The event includes `category_id` and `category_name`.
  - `channel.follow` v2, condition `{ broadcaster_user_id, moderator_user_id: broadcaster id }`, scope `moderator:read:followers`
- Chat (bot connection, or the broadcaster connection in single-account mode):
  - `channel.chat.message` v1, condition `{ broadcaster_user_id, user_id: <bot or streamer id> }`, scope `user:read:chat`. Use `message_id`, `chatter_user_id`, `chatter_user_login`, `chatter_user_name`, `message.text`, `badges[]` (`set_id` values `broadcaster`, `moderator`, `vip`).
- Keepalive: if nothing (notification or keepalive) arrives within `keepalive_timeout_seconds`, reconnect and resubscribe.
- `session_reconnect`: connect to `reconnect_url`, wait for the new welcome, then close the old socket. Do not resubscribe in that case.
- Handle `revocation` messages: log them clearly and show a warning in the dashboard.
- Never process the same `message_id` twice (keep a short in-memory dedupe set).

**Helix endpoints you will need:**
- `GET /helix/users?login=` and `GET /helix/users` (current user)
- `POST /helix/chat/messages` with `{ broadcaster_id, sender_id, message }`, scope `user:write:chat`. Max 500 characters, so truncate safely.
- `DELETE /helix/moderation/chat?broadcaster_id=&moderator_id=&message_id=`, scope `moderator:manage:chat_messages`. Twitch rules: only messages from the last 6 hours, and you **cannot delete messages from the broadcaster or other moderators**.
- `GET /helix/moderation/moderators?broadcaster_id=&user_id=`, scope `moderation:read`. At startup, check the bot is a moderator. If not, show a red banner in the dashboard: "Type /mod <botname> in your chat".
- `GET /helix/channels?broadcaster_id=` (current category)
- `GET /helix/streams?user_id=` (is the stream live right now)
- `GET /helix/channels/followers?broadcaster_id=` (use `total`)
- `GET /helix/search/categories?query=` (category picker in the dashboard; always store and compare the category **ID**, never the name)
- `POST /helix/channels/vips?broadcaster_id=&user_id=` and `DELETE /helix/channels/vips?...`, scope `channel:manage:vips`, broadcaster token only. Handle every documented error with a friendly dashboard message: 409 no free VIP slots, 422 user is a moderator or already VIP (for removal: not a VIP), 425 channel must complete "Build a Community", 429 too many VIP changes in 10 seconds (retry later), 400/401/404.

### 4. Data model (SQLite)

- `capsules`: id, slug (url-safe, unique), title, trigger_type (`date` | `followers` | `category` | `manual`), trigger_value (JSON: ISO date, follower number, or `{ category_id, category_name }`), status (`sealing` | `locked` | `ready` | `opening` | `opened` | `archived`), created_at, locked_at, ready_at, opened_at, settings JSON (max seals per user, max length, VIP reward on/off, VIP days).
- `seals`: id, capsule_id, number (1, 2, 3 … per capsule, assigned in a transaction), user_id, user_login, display_name, text, created_at, chat_message_id, hidden (bool: did the delete succeed), status (`pending` | `approved` | `rejected` | `revealed`), came_true (bool), revealed_at.
- `prophets`: id, capsule_id, seal_id, user_id, user_login, vip_granted_at, vip_expires_at, vip_removed_at, vip_error.
- `events_log`: id, at, type, payload JSON (for debugging and the demo timeline).

Rules: only one capsule can be in `sealing` at a time. `!seal` always goes to that one.

### 5. Chat commands

- `!seal <text>`
  1. Check that there is an active `sealing` capsule; if not, reply `No capsule is open for sealing right now.`
  2. Validate: text 3 to 280 characters, per-user limit (default 3 per capsule), per-user cooldown 10 seconds, blocked-word list (`data/blocked-words.txt`, editable, case-insensitive, whole words). Rejected seals get a short reply and are not stored.
  3. Store the seal and assign its number.
  4. Delete the chat message with the bot token. If deleting fails because the sender is the broadcaster or a moderator (Twitch does not allow it), still store it, set `hidden = false`, and reply: `Sealed #N from @user (mods' and the streamer's messages can't be hidden in chat).`
  5. Reply: `Sealed message #N from @user. Opens: <condition text>.` Combine replies when many seals arrive within 3 seconds (`Sealed #214–#219 from @a, @b, @c…`) so the bot never spams chat.
- `!capsule`: reply with the title, sealed count, opening condition (with countdown for dates) and the public page link. Cooldown 30 seconds.
- Mod and broadcaster only (check badges): `!capsule lock` (stop accepting seals), `!capsule open` (manual trigger), `!capsule status`.
- Ignore messages sent by the bot itself.

### 6. Trigger engine

- `date`: check every 30 seconds.
- `followers`: on each `channel.follow` event, plus a poll of `total` every 5 minutes and at startup.
- `category`: on `channel.update` (compare `category_id`), on `stream.online` (then fetch `GET /helix/channels`), and at startup.
- `manual`: dashboard button or `!capsule open`.

When the condition becomes true, set `ready`. The capsule **only opens while the stream is live**:
- If live (tracked from `stream.online`/`stream.offline`, checked with `GET /helix/streams` at startup), wait 5 seconds, then move to `opening` and start the ceremony.
- If offline, stay `ready` and open on the next `stream.online`, after a 60-second delay (configurable) so the streamer can settle in.
- The dashboard always shows a big "Open now" button and a "Postpone" button.
- Make the trigger engine pure and unit-testable (input: capsule + current facts; output: next state).

### 7. Ceremony and overlay

Overlay page: `http://localhost:3000/overlay?key=<OVERLAY_KEY>`, built for an OBS Browser Source at 1920x1080.
- `html, body` background must be fully transparent. Outside the ceremony, render nothing at all.
- Connect to the server over WebSocket. Reconnect automatically. On reconnect, restore the current ceremony state.
- **Security: render all viewer text with `textContent`, never `innerHTML`.** Chat text is untrusted (XSS).
- Respect `prefers-reduced-motion`.

Ceremony state machine (server-side; the dashboard controls it, the overlay displays it):
1. `opening`: a capsule animation in the center of the screen (CSS/SVG: a gold capsule splits open with soft light rays), the text "TIME CAPSULE OPENED" and "N messages sealed since <date>". About 6 seconds.
2. `queue`: the overlay shows only a small header "TIME CAPSULE · OPENED" on the right side while mods approve messages in the dashboard.
3. `reveal`: when the streamer clicks "Reveal next" (or presses the hotkey `N` in the dashboard, or turns on auto-reveal every X seconds), the next approved seal slides in as a card in a column on the right side of the screen, so the game stays visible on the left. Card: `@display_name`, `sealed <date>`, and the message in quotes. Keep the 3 newest cards; older ones slide away.
4. `prophet`: when the streamer clicks "Came true" on a revealed card, the card gets a green "CAME TRUE" stamp, a gold "PROPHET" badge appears next to the name, and a banner shows "@user gets VIP for 30 days" (or "@user is a Prophet!" when VIP is off). The bot posts in chat: `@user's prediction came true. Prophet!` (+ ` VIP for 30 days.` when granted).
5. `ended`: the streamer clicks "End ceremony", the overlay fades out completely, and the capsule becomes `opened`.

Side (right or left), card scale and auto-reveal timing are settings in the dashboard.

### 8. Dashboard (`http://localhost:3000/dashboard?key=<ADMIN_KEY>`)

Bind the server to `127.0.0.1` by default. Generate `ADMIN_KEY` and `OVERLAY_KEY` on first run if missing, store them in `data/keys.json`, and print the URLs in the console. Reject requests without the right key.

Sections:
- **Connection**: connect streamer and bot, show token status, bot-is-mod check, EventSub status (connected, subscriptions list, last keepalive), live or offline.
- **Capsules**: create a capsule (title, trigger type and value, category search with live results, limits, VIP reward on/off with days), list capsules with status and counts, lock, open now, postpone, archive, copy public link.
- **Mod queue** (during the ceremony): every seal with approve/reject buttons, filters (pending, approved, rejected), a "flagged" mark for seals that contain blocked words, and "Reveal next".
- **Prophets**: revealed seals with a "Came true" button, VIP status per prophet, retry on VIP errors, and the expiry date.
- **Overlay**: copy the OBS URL, a test button that plays a 10-second preview ceremony with fake data.
- **Log**: the latest 100 events from `events_log`.

VIP expiry: store `vip_expires_at`. At startup and every hour, remove VIP for expired prophets (only VIPs granted by this app). Log errors and show them in the dashboard.

### 9. Public capsule page (`/c/:slug`)

- Before opening: title, channel name, condition ("Opens the first time <channel> streams Grand Theft Auto VI" / a live countdown to the date / "Opens at 1,000 followers: now 812"), sealed count, how to seal (`!seal your message` in chat). **Never show sealed texts before the capsule is opened.**
- After opening: revealed messages (approved only), and the Wall of Prophets.
- Clean, mobile-friendly, dark theme with gold accents. No user data beyond display names and revealed texts.

### 10. Demo mode (very important for judges)

`npm run demo` must work with **no Twitch account and no `.env` secrets**:
- Starts the server with a fake Twitch layer (same interfaces as the real one) and a demo database.
- Opens a demo control page `http://localhost:3000/demo` with buttons: "Send fake !seal messages" (20 sample viewers with realistic predictions), "Fast-forward the date", "Simulate the category change to Grand Theft Auto VI", "Go live", plus the overlay embedded at 1920x1080 over a sample gameplay background image, and the dashboard side by side.
- A "Play full story" button runs the whole flow automatically in about 90 seconds: seals arrive, the capsule waits, the stream goes live, the category changes, it opens, mods approve, cards reveal, one prediction comes true, the Prophet gets fake VIP.
- Also document how to test the real EventSub client against the Twitch CLI mock WebSocket server (`twitch event websocket start-server`, then `twitch event trigger channel.update --transport=websocket`). Check the exact CLI flags with `twitch event --help` and write what actually works into the README.

### 11. Tests (Vitest)

At least:
- `!seal` parsing and validation (length, blocked words, cooldown, per-user limit, no active capsule).
- Seal numbering is sequential and unique, even when seals arrive at the same time.
- Reply batching.
- Trigger engine: every trigger type, live versus offline, ready to opening, postpone, manual.
- Category compare by ID, not name.
- Ceremony state machine transitions, including invalid transitions.
- VIP expiry selection logic and handling of every VIP error code.
- EventSub client: welcome → subscribe, keepalive timeout → reconnect, `session_reconnect` flow, dedupe (use a fake WebSocket server).
- Overlay escaping: a seal containing `<img src=x onerror=alert(1)>` is shown as plain text.

### 12. Security and privacy

- Never commit secrets. Add `.env.example` with every variable and a comment explaining each one. Gitignore `.env`, `data/`.
- Escape all viewer text everywhere (overlay, dashboard, public page).
- Do not log tokens or secrets. Redact them if an error includes them.
- Validate and limit all inputs on every route.
- Store only what's needed: user id, login, display name, seal text.

### 13. README (judges read this first)

Include:
- A one-paragraph pitch and a GIF or screenshot of the ceremony.
- The problem (Predictions max 30 minutes, fixed answers, current stream only) and the solution.
- Quick start in 3 commands for demo mode.
- Full setup with real Twitch: register the app (redirect URL, client type), `.env`, connect accounts, `/mod` the bot, add the OBS Browser Source (URL, 1920x1080, "Shutdown source when not visible" OFF, "Refresh browser when scene becomes active" OFF).
- Every Twitch API feature used (EventSub types, Helix endpoints, scopes) and why.
- Architecture diagram (Mermaid).
- A "How I used Codex" section: leave a clear placeholder for me to fill in.
- Known limitations (the app must be running to catch triggers; mods' and the broadcaster's seals can't be hidden in chat; VIP needs free slots and the Build a Community achievement).

### 14. Build phases (stop after each one)

1. **Skeleton**: project setup, config with zod, Fastify server, SQLite with migrations, lint, a first test, README stub, `.env.example`, `.gitignore`. Acceptance: `npm run dev` serves a health page at `/health`, `npm test` passes.
2. **Twitch auth + Helix client**: OAuth for streamer and bot, token storage, refresh, hourly validation, the bot-is-mod check, dashboard "Connection" section. Acceptance: I can connect both accounts and see their names and the mod status.
3. **EventSub client + chat**: WebSocket client with welcome, subscriptions, keepalive, reconnect, revocation, dedupe; sending chat messages. Acceptance: when I type in chat, the dashboard log shows it; `!capsule` gets a reply.
4. **Capsules + `!seal`**: create capsules in the dashboard, `!seal` with deletion, validation, numbering, batching; public page before opening. Acceptance: my test viewer's `!seal` disappears from chat and the count goes up.
5. **Trigger engine**: all four triggers, live/offline handling, open-now and postpone. Acceptance: a capsule with "first stream in category X" opens when I go live and switch to X (or via Twitch CLI).
6. **Ceremony + overlay**: state machine, overlay animations, mod queue, reveal controls, hotkeys, preview button. Acceptance: in OBS I see nothing until the capsule opens, then the full ceremony.
7. **Prophets + VIP**: came-true flow, VIP grant with error handling, expiry job, Wall of Prophets on the public page. Acceptance: marking a card as true shows the stamp, posts in chat, and adds VIP (or shows a clear error).
8. **Demo mode**: fake Twitch layer, demo page, "Play full story". Acceptance: `npm run demo` on a fresh clone with no `.env` plays the whole story.
9. **Polish + README**: visual polish of overlay and pages, accessibility, final tests, complete README, MIT license. Acceptance: fresh clone → README steps work exactly as written.

### 15. Quality bar

- Before writing code in each phase, briefly list what you will build and which files you will touch.
- Handle errors visibly: dashboard banners, never silent failures.
- Keep functions small, typed and tested. No `any` unless commented why.
- If a Twitch detail in this prompt conflicts with the official docs, follow the docs and tell me what you changed.
- When you are unsure about a requirement, ask me before building it.

Start with Phase 1 now.
