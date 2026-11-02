# Manual recording checklist — fresh Time Capsule walkthrough

Use romilg16 as the streamer, romil100 as the bot, and romiltest1 plus romiltest2 as ordinary viewers. These instructions do not change any accounts or data automatically.

## 1. Prepare the browsers and recording

- Browser/profile A: Twitch signed in as romilg16, plus the Time Capsule dashboard.
- Browser/profile B: Twitch signed in as romiltest1.
- Browser/profile C: Twitch signed in as romiltest2. Open https://www.twitch.tv/romilg16 . A separate browser profile/private window prevents accidental account switching.
- romil100 is the bot. Do not send viewer !seal tests from this account: the app ignores its own bot account.
- Keep both romiltest1 and romiltest2 ordinary viewers, not moderators, so Twitch can delete their sealed messages.
- Record setup/dashboard clips while the Twitch stream is stopped. For the actual live stream, capture a safe background window with the Time Capsule overlay above it. Avoid broadcasting the private moderation queue.
- Keep passwords, client secrets, dashboard keys and overlay URLs out of the recording. Stop recording while entering credentials or copying private URLs, then restart for the next segment.

## 2. Start the installed project — Phase 1

If the server is already running on port 3000, use that instance or stop its terminal with Ctrl+C before restarting. In WSL:

```sh
cd ~/hackathon_projects/time-capsule
export PATH="$PWD/.tools/node/bin:$PATH"
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm run dev
```

Do not close this terminal during the walkthrough. Open http://localhost:3000/health : status and database should both be ok. Open the complete Dashboard URL printed in the terminal. Keep its key private. The project and Twitch developer application already exist; there is no need to register a new developer application or replace the existing credentials for this fresh recording.

If you deliberately want to show developer registration in your recording, the existing app uses Chat Bot, Confidential client, and exactly http://localhost:3000/auth/callback . Show the settings with credentials hidden; avoid generating a new secret during a working recording setup.

## 3. Confirm the existing streamer and bot — Phase 2

1. Keep romilg16 connected as the streamer. Only disconnect a streamer account if a different account is shown.
2. In the SAME browser/profile as this dashboard, sign in to Twitch as romilg16.
3. If romilg16 is already connected, keep it. Otherwise click Connect streamer account and authorize romilg16. Check the username on the Twitch consent page.
4. The left card must show romilg16. The right card should continue showing romil100 connected.
5. Only if the bot is disconnected/expired: sign in to Twitch as romil100 in that same profile, click Connect bot account, authorize romil100, then sign back into Twitch as romilg16. Already connected bot tokens do not need another login just for the recording.
6. While signed in as romilg16, open its own channel chat and send:

```text
/mod romil100
```

7. Click Recheck connection. Expect streamer romilg16, bot romil100, Ready to moderate, and EventSub Connected. Both viewer accounts send messages in romilg16’s channel.

## 4. Optional clean dashboard

If old test data remains and you want to clear it, end any active ceremony, then use Capsules → Delete all and confirm only after reviewing the deletion message. Capsule deletion also removes its saved messages and Prophet records. Prophets → Delete all instead removes only revealed predictions and their recognition; capsules and unrevealed messages remain. Accounts/settings remain, and existing VIP awards retain their expiry tracking. Do not delete .env, token files, keys, or the whole data folder.

Do cleanup before recording the main test; keep the new demo capsule until after you record the final public wall.

## 5. Check chat and EventSub — Phase 3

From romiltest1, in romilg16's chat:

```text
hello Time Capsule
!capsule
```

Expect a chat.received entry in Channel activity. With no sealing capsule, romil100 should reply that no capsule is open for sealing. The !capsule status reply has a 30-second cooldown, so wait before repeating it. Chat testing works while offline.

## 6. Configure OBS and a local recording

1. OBS → Settings → Stream. Keep OBS connected to romilg16. If another account is connected, reconnect romilg16. Do not stream as romil100 or either viewer account.
2. Create a scene called Time Capsule Demo.
3. Add a Window Capture for a safe window, such as Notepad displaying Time Capsule Demo. Keep its eye icon visible. A game is optional.
4. Set Stream Information title to Time Capsule — Live Demo. Choose Just Chatting or another available category for the main manual test, then save with Done.
5. Dashboard → Your OBS overlay → Copy OBS URL. Add Sources → + → Browser, name it Time Capsule Overlay, and paste that URL privately.
6. Set width 1920, height 1080. Leave Shutdown source when not visible and Refresh browser source when scene becomes active OFF. Keep the Browser Source visible and above the background capture.
7. Click Play 10-second preview in the dashboard. Sample cards should appear, then disappear. This is a preview, not a real VIP grant.
8. Check microphone levels and recording path/format in OBS Settings → Output. MKV is a practical recording format; remux to MP4 afterward.
9. Start Recording saves a local file. Start Streaming sends the scene to Twitch. They are separate controls and can run together. Keep setup/dashboard recordings separate from the public safe-background live scene.

An idle overlay is transparent. Black with no visible background capture is expected. You do not need to open the overlay URL in a normal browser first.

## 7. Create the main capsule — Phase 4

Create this capsule in the private dashboard:

- Title: First Stream Time Capsule
- Opening condition: When I choose
- Seals per viewer: 5
- Maximum length: 280
- Reward Prophets with VIP: checked
- VIP days: 30

Click Create capsule. Expect SEALING and zero messages. Do not click Open now yet.

## 8. Seal messages from both test viewers

Send the first two messages as romiltest1 and the last two as romiltest2 in romilg16’s Twitch chat. Wait at least 10 seconds between messages from the same viewer:

```text
!seal I predict this message will appear on stream.
!seal I predict we will see a gold capsule opening.
!seal Hello to everyone watching this later.
!seal Reject this message for the moderation demonstration.
```

romil100 should delete each viewer message and send numbered receipts. The capsule count should reach four. A batched receipt or a short send delay is normal. Open View public page and record the title/condition/count: private message text must not be shown there.

## 9. Go live and open manually — Phase 5

1. In OBS, switch to the safe-background scene with the visible overlay above it.
2. Click Start Streaming. Confirm romilg16 is LIVE on Twitch.
3. Click Recheck connection if necessary; the dashboard must show Live for romilg16.
4. Now click Open now on First Stream Time Capsule.
5. Expect approximately five seconds of trigger delay and six seconds of opening animation, then the private moderation queue.

If you clicked Open now while OFFLINE, the capsule remains READY and waits for a live stream. Your normal app's offline settling delay is 60 seconds. Clicking Open now after you are live overrides the condition/postponement and schedules the normal five-second delay. Never confuse the five-second live delay with the 60-second offline-ready settling delay.

## 10. Moderate and reveal — Phase 6

- Approve messages #1, #2, and #3.
- Reject message #4.
- Pending becomes empty after decisions; use Approved or All to inspect the accepted entries.
- Click Reveal next for #1, or press N while no text field is focused.
- Start auto-reveal to reveal the other approved messages at the configured interval; an interval of 5–8 seconds is easy to record.
- The rejected message must never appear on the overlay. Only the newest three approved cards remain visible.
- Record the OBS scene/Twitch output showing the reveal. The private queue should not itself be captured in the public stream.
- Keep the ceremony active until the Prophet recording is complete.

## 11. Mark a prediction Came true — Phase 7

The first prediction, “this message will appear on stream,” becomes true after its reveal. Find it in Prophets and click Came true. Record the PROPHET badge, CAME TRUE stamp, and the romil100 chat announcement mentioning romiltest1.

VIP is a separate Twitch result. If granted, record the confirmed grant and expiry. If Twitch reports no slots, missing eligibility, permissions, or another error, show that result honestly. A new channel may not be able to grant VIP. Recognition still works. Do not make romiltest1 a moderator just to test VIP. Retry VIP only after resolving the reported issue; the account-free demo can show fake VIP success separately.

## 12. End the ceremony and view the public wall

Click End ceremony. Expect OPENED and an empty transparent overlay. Refresh View public page: romiltest1 should appear on the Wall of Prophets after being marked true. Public message texts stay private. Record the count, name, and finished state. Keep this capsule until the video is complete.

## 13. Extra manual trigger demonstrations

Do each as a separate capsule. End each ceremony before the next one opens; lock or archive any current sealing capsule before creating a new collecting capsule.

### Date

Create Date Trigger Test with On a date at least 2–3 minutes ahead. Seal a message before that deadline. Date checks run about every 30 seconds. Show READY while offline, then go live and wait for the configured 60-second settling delay plus the opening animation. Alternatively, test while already live for the five-second delay after the condition is detected.

### Followers

Create Follower Goal Test with a target one higher than the current follower total. Seal a message. Have an account that does not already follow romilg16 follow it. Use Recheck connection to refresh authoritative facts if necessary. While live, reaching the target should schedule opening. Do not fake a follower count on the real app; use demo mode for repeatable simulated changes.

### Category

Create Category Trigger Test, selecting a category DIFFERENT from the current Twitch stream category. Seal a message. Go live in the original category and show that it does not open yet. In Twitch/OBS Stream Information, change to the category selected for the capsule. Expect readiness and opening after the live delay. The selected category ID controls the trigger; a title such as GTA 6 does not change the Twitch category. An offline category change alone does not open it.

### Postpone / lock / archive / deletion

On a waiting test capsule, click Postpone 10 min and show its new deadline. Open now while live can clear that postponement. Lock sealing to stop new messages while preserving old ones. Archive to preserve the capsule without continuing its normal workflow. Finally, if you want to demonstrate Delete or Delete all, use disposable test capsules/predictions and read the confirmation before proceeding. Do not remove your main recorded evidence prematurely.

## 14. Optional validation clips

Use another manual capsule configured with a three-message per-viewer limit. Demonstrate a too-short !seal, a second accepted-message attempt within ten seconds, and a fourth accepted-message attempt after the three-message allowance. Rejected inputs must not increase counts. A normal viewer cannot use !capsule open; the broadcaster romilg16 can use it with this separate-bot setup. Commands from romil100 itself are ignored.

## 15. Show the isolated demo — Phase 8

Keep the normal server running. In a SECOND WSL terminal:

```sh
cd ~/hackathon_projects/time-capsule
export PATH="$PWD/.tools/node/bin:$PATH"
npm run demo -- --port=3001
```

Open http://localhost:3001/demo . Click Play full story and record about 90 seconds. Expect twenty seals, simulated live/category changes, approved reveals, one fake VIP, and a cleared overlay at completion. Label it as demo/simulated. Stop story before using manual controls for date, follower goal, category change, approval, reveal, Came true, or ending. This server uses separate storage/accounts and does not change the real channel.

## 16. Optional CLI proof

This is a separate production EventSub-client check, not a requirement for the normal live recording. Do not present mock CLI events as real Twitch events.

Terminal 1, in the project root:

```sh
cd ~/hackathon_projects/time-capsule
./.tools/twitch-cli/twitch-cli_1.1.24_Linux_x86_64/twitch event websocket start-server --require-subscription
```

Terminal 2:

```sh
cd ~/hackathon_projects/time-capsule
export PATH="$PWD/.tools/node/bin:$PATH"
npm run test:cli
```

Wait for `CLI subscription ready: channel.update v2`.

Terminal 3:

```sh
cd ~/hackathon_projects/time-capsule
./.tools/twitch-cli/twitch-cli_1.1.24_Linux_x86_64/twitch event trigger channel.update --transport=websocket --version=2 --to-user=10001 --game-id=900000001 --item-name="Grand Theft Auto VI"
```

Record the forwarded event and the client notification. Stop the CLI and harness with Ctrl+C afterward. The mock broadcaster/category IDs are fictional and do not correspond to your real channel.

## 17. Finish and export

Stop Streaming if your live test is finished, then Stop Recording. OBS File → Remux Recordings converts an MKV capture to MP4. Keep the original recordings, remove credential/private-key frames from the edit, and combine the setup, live overlay, moderation, public wall, and simulated demo clips.

Suggested narration: “A viewer seals a prediction in Twitch chat. The bot stores it and removes the chat message. The capsule opens only when its condition is met while live. I approve the safe messages and reveal them on stream. Correct predictions become Prophets, with optional VIP rewards. A separate demo lets anyone try the whole flow without a Twitch account.”

Official OBS references: https://obsproject.com/kb/browser-source and https://obsproject.com/kb/standard-recording-output-guide . App-specific behavior is documented in README.md and implemented in src/capsule/.
