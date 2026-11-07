# Room bot

Puts each online Room agent in the LiveKit call as a participant named after the agent. It shows the
agent's status and speaks short versions of its replies. Speech is rendered to a file with macOS `say`
(free, on-device) and published as an audio track. Nothing plays on the host's speakers.

Unlike the Room, this package has dependencies (`@livekit/rtc-node`, `livekit-server-sdk`, both pinned).
It is not part of the pnpm workspace; install it with npm.

```bash
cd apps/room-bot
npm install
ROOM_URL=http://127.0.0.1:4780 \
ROOM_TOKEN_FILE=<file holding a connector token> \
ROOM_LIVEKIT_URL=wss://<livekit host> \
ROOM_LIVEKIT_KEY=<api key> \
ROOM_LIVEKIT_SECRET_FILE=<file holding the api secret> \
node src/bot.ts
```

Optional: `ROOM_LIVEKIT_ROOM` (default `room`), `ROOM_BOT_VOICE` (a `say -v` voice), and
`ROOM_BOT_SPEECH=off` to turn speech off entirely. `ROOM_URL` may include a path prefix.

## What it publishes

Participant `agent-<name>` carries these attributes: `kind` (`agent`), `status` (`idle`, `working`,
`needs approval`, `speaking`), `task`, `muted`, `speech` (`on` or `off`) and `speaking`.

Bots start muted and skip speech until unmuted. Send a data message on the topic `bot-control` with
`{"muted": false}` (optionally `"agent": "<name>"` for one bot) to turn speech on, and `true` to mute.

## Test

```bash
npm test
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp livekit/livekit-server --dev --bind 0.0.0.0 --node-ip 127.0.0.1
```

On macOS, Docker needs `--node-ip 127.0.0.1` or clients time out connecting. The dev server's key and
secret are `devkey` and `secret`. A subscriber should check the audio track's levels, not play it.
