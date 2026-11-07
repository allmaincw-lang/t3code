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

## Use it with other people

Everyone must be on the same tailnet. On the host, publish the room over HTTPS, because browsers only
allow cameras on HTTPS or localhost:

```bash
ROOM_URL=https://<host>.<tailnet>.ts.net node src/server.ts invite "Partner"
tailscale serve --bg 4780
```

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
