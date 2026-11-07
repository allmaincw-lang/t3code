// Meeting state that lives only while someone is connected: raised hands, mute
// flags and emoji reactions. Nothing here is written to the event log.

export const REACTIONS = ["👍", "👏", "❤️", "😂", "🎉", "😮"];
const REACTION_GAP_MS = 400;

type Peer = { id: string; person: string; kind: string; inCall: boolean };
type State = { hand: boolean; muted: boolean | null; reactedAt: number };

export const createMeeting = (deps: {
  broadcast: (type: string, data: unknown) => void;
  find: (id: unknown) => Peer | undefined;
  fail: (status: number, message: string) => never;
  now?: () => number;
}) => {
  const now = deps.now ?? Date.now;
  const states = new Map<string, State>();

  const snapshot = () =>
    [...states].flatMap(([id, state]) =>
      state.hand || state.muted !== null ? [{ id, hand: state.hand, muted: state.muted }] : [],
    );
  const publish = () => deps.broadcast("meeting", snapshot());

  // The caller's identity comes from the invite; the connection id only picks which of their tabs.
  const own = (body: Record<string, unknown>, person: string) => {
    const peer = deps.find(body.connectionId);
    if (!peer || peer.person !== person || peer.kind !== "browser") {
      return deps.fail(404, "Unknown connection.");
    }
    return peer;
  };
  const stateOf = (id: string) => {
    let state = states.get(id);
    if (!state) {
      state = { hand: false, muted: null, reactedAt: 0 };
      states.set(id, state);
    }
    return state;
  };

  const forget = (id: string, keepHand: boolean) => {
    const state = states.get(id);
    if (!state) return;
    state.muted = null;
    if (!keepHand) state.hand = false;
    if (!state.hand && state.reactedAt === 0) states.delete(id);
    publish();
  };

  return {
    snapshot,
    // Leaving the call lowers the hand and clears mute; disconnecting drops everything.
    leftCall: (id: string) => forget(id, false),
    disconnected: (id: string) => {
      if (!states.delete(id)) return;
      publish();
    },
    handle: (route: string, body: Record<string, unknown>, person: string): unknown => {
      if (route === "POST /api/meeting") {
        const peer = own(body, person);
        const state = stateOf(peer.id);
        if (body.hand !== undefined) {
          if (typeof body.hand !== "boolean") return deps.fail(400, "hand must be true or false.");
          state.hand = body.hand;
        }
        if (body.muted !== undefined) {
          if (typeof body.muted !== "boolean") return deps.fail(400, "muted must be true or false.");
          if (peer.inCall) state.muted = body.muted;
        }
        publish();
        return { ok: true };
      }
      if (route === "POST /api/react") {
        const peer = own(body, person);
        const emoji = body.emoji;
        if (typeof emoji !== "string" || !REACTIONS.includes(emoji)) {
          return deps.fail(400, "Pick one of the room's reactions.");
        }
        const state = stateOf(peer.id);
        if (now() - state.reactedAt < REACTION_GAP_MS) return deps.fail(429, "Slow down a little.");
        state.reactedAt = now();
        deps.broadcast("reaction", { connectionId: peer.id, person, emoji });
        return { ok: true };
      }
      return undefined;
    },
  };
};
