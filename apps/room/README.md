# Room

A shared room where people and T3 Code agents chat, and people see and hear each other. It has no
dependencies beyond Node 24 and an installed `t3` CLI.

- `src/server.ts` holds accounts, chat, approvals, a permanent event log, and call signaling. It runs
  no agents.
- `src/connector.ts` runs on each machine with agents. It signs in as that machine's owner and starts
  T3 threads through the `t3` CLI.

## Start the room

```bash
node src/server.ts invite "Your Name"
node src/server.ts
```

The first command prints an invite link and a connector token. Anyone holding them acts as that
person, so send them privately. People's chat lives in `.data/`.

## Add a machine's agents

Copy `connector.example.json` to `connector.local.json`, fill it in, and run this on that machine:

```bash
ROOM_TOKEN=<that person's connector token> node src/connector.ts connector.local.json
```

Find project ids in the output of `t3 project add <path>`. `room` is the room's address as this
machine reaches it.

To keep agents from overwriting each other, give each one its own `worktree` (the branch, tag, or
commit to start from) and `branch` (the new branch it works on). Worktrees start from committed code,
so they do not include uncommitted changes in the project folder.

## Use it with other people

Everyone must be on the same tailnet. On the host, publish the room over HTTPS, because browsers only
allow cameras on HTTPS or localhost:

```bash
ROOM_URL=https://<host>.<tailnet>.ts.net node src/server.ts invite "Partner"
tailscale serve --bg 4780
```

If another app already uses that address, publish the room under a path and add it to `ROOM_URL`,
with a trailing slash:

```bash
tailscale serve --bg --set-path=/room http://127.0.0.1:4780
```

Tailnet access rules must allow the port. A rule that only allows 443 blocks any other HTTPS port.

## Dictation on this computer

The Talk button records in the browser and sends the audio to the room, which hands it to T3's own
speech engine (the Handy models), so it never goes to Apple or Google. Without this setup Talk falls
back to the browser's built-in recognition. T3 must be running with a speech model downloaded.

On the machine that runs T3 and the room, create a T3 key, then point the room at it. It is saved
owner-readable only, and the key is never printed. The key is not limited to speech: T3's
transcribe endpoint requires `orchestration:operate`, which can also start agent threads, so keep the
file private and revoke the key in T3's Sharing & access settings if it leaks.

```bash
mkdir -p ~/.connected-empire && (umask 077 && t3 auth session issue --scope orchestration:operate --label "Room voice" --ttl 30d --token-only > ~/.connected-empire/room-voice.token)
ROOM_T3_URL=http://127.0.0.1:3773 ROOM_T3_VOICE_TOKEN_FILE=$HOME/.connected-empire/room-voice.token node src/server.ts
```

Other scripts on the page can use `window.roomVoice` (see `createRoomVoice` in `public/voice.js`):
`await roomVoice.ready`, check `roomVoice.source` is `"local"` (otherwise it is `"browser"` and
`start()` rejects), then `await roomVoice.start()` and `const text = await roomVoice.stop()`. Also
`state`, `cancel()` and `onstatechange`.

`orchestration:operate` is the narrowest scope T3's transcribe endpoint accepts. The room reads the
file on each request, so a new key takes effect without a restart. Recordings are limited to 5
minutes and are never stored or logged.

## Who can run what

Threads started through the `t3` CLI use the project's default permission mode, which is Full access
unless changed. A message from anyone but an agent's owner therefore waits for the owner's Approve
button, and the connector refuses work its owner did not approve. Set the project to Supervised in T3
if each command should also ask. Those approvals are answered in T3, and the room only shows that one
is waiting.

Video is peer to peer with no relay, so it works across a tailnet or local network but not the open
internet.

## Tests

```bash
node --test src/room.test.ts
```

## Jarvis extras (all opt-in)

A panel above the tiles, built in `public/jarvis.js` and `public/jarvis.css`:

- **Push-to-talk.** Pick an agent, hold the button or the space bar outside a text box, release, check
  the transcript, and send. It uses `window.roomVoice` when present and the browser's speech
  recognition otherwise. "Send what I say without asking" skips the check. The message is an
  ordinary @mention, so the owner's approval still applies.
- **Spoken replies.** Off by default. Uses the browser's own `speechSynthesis`, with a stop button.
- **Face.** A ring that shows listening, thinking (the agent is working), needs approval, and speaking.
  It only reads signals the Room already has and uses short transitions, so it is still when idle.
- **Memory.** Add `"memory": {"dir": "/absolute/folder"}` to the connector config. The agent's owner
  then gets a switch in the panel. While it is on, `remember: ...` messages from the owner append a
  note to `<dir>/<room>/<project>.md` on the owner's machine, and a size-capped excerpt goes into that
  agent's prompt as background. Nothing is written to a git repository unless `memory.allowInRepo` is
  true.
- **Camera gesture.** Covering the camera lens for about a second starts or stops push-to-talk. It
  needs its own camera permission and never touches raise-hand. It is a brightness check, not hand
  tracking, because hand-tracking libraries need WebAssembly, which the Room's content security
  policy does not allow.

Ideas come from the public descriptions of jaredrhod's Backtalk, AI Visualizer and AI Memory Vault.
Those are AGPL-3.0 and CC-BY-SA-4.0, so no code or assets were copied.
