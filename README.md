# Time Capsule

Seal Twitch chat predictions today and reveal them together on a future stream. Choose a manual opening, date, follower goal, or first stream in a category. Approve messages before showing them in OBS, celebrate correct predictions as **Prophets**, and optionally award temporary Twitch VIP.

## Run the demo

Requires **Node.js 20.19+ (24 recommended)**, npm, and Git. OBS is only needed to broadcast the overlay.

```sh
git clone https://github.com/romilp619/twitch-time-capsule.git
cd twitch-time-capsule
npm ci
npm run demo
```

Open the **Demo** URL printed in the terminal, normally `http://localhost:3000/demo`, and click **Play full story**. The 90-second walkthrough uses 20 sample viewers and fake Twitch events; no account, credentials, or real chat/VIP changes are involved.

If port 3000 is busy, the demo tries 3001. Choose another port with `npm run demo -- --port=3002`. Press **Ctrl+C** to stop.

## Connect a real Twitch channel

1. Stop the demo and copy the configuration template:

   ```sh
   cp .env.example .env
   ```

2. Register a **Confidential** application in the [Twitch Developer Console](https://dev.twitch.tv/console/apps). Register this exact OAuth redirect URL:

   ```text
   http://localhost:3000/auth/callback
   ```

3. Add your application's credentials to `.env`:

   ```dotenv
   TWITCH_CLIENT_ID=your_client_id
   TWITCH_CLIENT_SECRET=your_client_secret
   ```

   Keep the default `BASE_URL=http://localhost:3000` and matching `TWITCH_REDIRECT_URI`. Other settings are explained in [.env.example](.env.example).

4. Run `npm run dev`. Open the complete private **Dashboard** URL printed in the terminal. Check `http://localhost:3000/health` for server/database status.
5. Under **Connection**, connect the streamer. A separate bot is optional; the streamer can handle chat alone. For a separate bot, sign into a **different Twitch account** before clicking **Connect bot account**.
6. As the streamer, send `/mod YOUR_BOT_USERNAME` in your channel chat, then click **Recheck connection**. Confirm moderation is ready and EventSub is connected. Use ordinary viewer accounts to test predictions; messages from the sending bot are ignored.

## Collect, reveal, and celebrate

1. In **Capsules**, enter a title and opening condition, then choose **Create & start collecting**. Keep VIP off for basic Prophet recognition; enable it only when you want Twitch role rewards.
2. Viewers send `!seal I predict we win the next round` in channel chat. Defaults: **3 messages per viewer per capsule**, **10 seconds apart**, and **3–280 characters** per message. Adjust the count and maximum length when creating a capsule. `!capsule` reports its status.
3. Collect messages **before** opening. The bot attempts to hide viewer submissions, although they can appear briefly. Broadcaster and moderator messages cannot be hidden. Sealing closes when opening begins.
4. Go live in OBS, then click **Open now** once or wait for the selected condition. Opening normally waits 5 seconds plus a 6-second animation. A capsule queued offline waits for a live stream and the configured settling delay (default 60 seconds). End the current ceremony before another can open.
5. In **Opening ceremony**, approve messages individually or with **Approve all**; reject unwanted messages. Use **Reveal next** or **Start auto-reveal**. Auto-reveal uses the interval set under **OBS overlay**.
6. In **Prophets**, mark a revealed prediction **Came true**. Recognition works without VIP. Optional VIP requires Twitch channel eligibility and an available slot; any failure is shown in the dashboard.
7. Click **End ceremony** to clear the overlay. **View public page** shows the Wall of Prophets with winning messages; other message contents remain private. To replay winners, select the completed capsule under **Stream Prophet showcase**. Playback scrolls automatically and supports pause, next, and stop.

## Add the OBS overlay

1. Under **OBS overlay**, copy the private Browser Source URL.
2. In OBS, add a **Browser** source at **1920 × 1080**, paste the URL, and place it above your game or window capture. Turn off **Shutdown source when not visible** and **Refresh browser when scene becomes active**.
3. Click **Play 10-second preview** in the dashboard. The overlay is transparent and empty between ceremonies; no browser tab needs to remain open for OBS to display it.

## Source, assets, and checks

All application source and required visual assets are included in this repository. Dependencies install from `package-lock.json`; no paid AI service or external media is needed at runtime.

| Location            | Contents                                                                    |
| ------------------- | --------------------------------------------------------------------------- |
| `src/`              | TypeScript server, SQLite migrations, Twitch integration, and isolated demo |
| `public/`           | Dashboard, public page, OBS overlay, and local demo artwork                 |
| `test/`             | Automated tests                                                             |
| `docs/screenshots/` | [Screenshots of the complete workflow](docs/screenshots/)                   |
| `.env.example`      | Configuration reference                                                     |

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm start
```

`npm start` runs the compiled server after a build. Run one normal server at a time; stop it with **Ctrl+C** before starting another on port 3000. In Windows, use Linux Node/npm consistently inside WSL, or run both natively.

Normal mode saves capsules, account tokens, and private keys under `data/`; demo mode uses separate fresh storage under `data/demo/`. Keep `data/` across restarts and keep `.env`, tokens, and dashboard/overlay keys private. Temporary VIP expiry is processed while the app is running and at the next startup. Localhost public links work only on the host computer; hosting needs persistent storage, a reachable HTTPS `BASE_URL`, and a matching Twitch callback.

MIT license — see [LICENSE](LICENSE).
