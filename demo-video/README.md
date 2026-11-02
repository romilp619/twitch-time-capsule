# Time Capsule narrated demo video

A separate Remotion project covering every completed build phase and all 37 screenshots supplied in the chat. It does not change the application or its database.

## Deliverables

- `out/Time-Capsule-Complete-Demo.mp4`: 1920×1080, 24 fps, narrated English walkthrough, synchronized burned captions and an optional caption track, chapter markers, and normalized speech.
- `out/Time-Capsule-Captions.srt`: captions for other players or uploads.
- `out/Time-Capsule-Transcript.md`: complete narration, with step timestamps.
- `out/Time-Capsule-Chapters.txt`: phase timestamps.
- `SCREENSHOT-COVERAGE.md`: exact mapping from every provided screenshot to its video step.

The complete video is about 13 minutes. It includes setup, Twitch OAuth, EventSub, chat command checks, capsule creation, seal deletion and receipts, all opening-condition types, offline/live gating, postponement, archiving, OBS configuration, source troubleshooting, moderation, manual and automatic reveal, Prophet recognition, the real VIP error, expiry behavior, the public wall, fake VIP demo mode, and Twitch CLI mock testing. Phase 9 is outside this video’s scope.

## Edit or render

Use Node 24 (the parent project’s bundled Linux Node works):

```sh
cd ~/hackathon_projects/time-capsule/demo-video
export PATH="$PWD/../.tools/node/bin:$PATH"
npm ci
npm run studio
```

`src/index.tsx` is the Remotion composition; `src/timeline.json` contains the complete timed narration and word boundaries. `storyboard.json` is the editable script. `asset-manifest.json` records screenshot provenance and redactions. The rendered composition uses only local sanitized screenshot assets and local narration audio.

```sh
node scripts/render.mjs --qa
npm run render
python3 scripts/package.py --mux
```

The QA command renders a still for each of the 46 scenes. The final command adds chapter markers and optional subtitles, normalizes narration to -16 LUFS, and enables MP4 fast start. Play the final MP4 with a video player; the Remotion project is also editable in Studio. For the local player with phase buttons, run `python3 scripts/serve.py` and open `http://localhost:8765/player.html`. The helper serves only the output folder on loopback and supports byte ranges for seeking.

## Assets and voice

Sanitized screenshot copies are under `public/screenshots/`. The original screenshots are read only from the user’s temporary attachments; they are not copied or modified. Browser address bars and the two private overlay URL fields are removed or covered before rendering. No real private dashboard or overlay key appears in exported assets.

Narration is synthetic English speech using `en-US-GuyNeural`, generated through edge-tts. Audio and word timings are cached locally. To regenerate after changing the script, run `scripts/voice.py` with edge-tts installed in `../.tools/video-python` (or adjust that import path); remove only the affected cached scene audio and word metadata first. Generating narration requires network access; playing and rendering the prepared project does not require Twitch or external media.

Remotion documentation: https://www.remotion.dev/docs/render and https://www.remotion.dev/docs/api . Versions are pinned in package-lock.json. The local Studio is an editing tool; no website or cloud deployment is part of this task.

Generated audio, sanitized assets, scratch files, node_modules and video exports are ignored by Git. Preserve the whole folder locally to retain its media. Use the final MP4 for sharing.
