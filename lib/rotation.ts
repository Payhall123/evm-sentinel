import "server-only";

// Round-robin rotation across a key's SMTP endpoints. The dispatcher asks for
// the next endpoint per message; consecutive failures place an endpoint into a
// short in-memory cooldown (circuit breaker) so the rotation moves on to the
// healthy servers instead of hammering the one that is erroring.
//
// State lives on globalThis so route handlers and server actions in the same
// Next.js process share one cursor. It is deliberately not persisted: losing
// the cursor across restarts only rebalances, which is harmless.

export type RotatableEndpoint = {
  id: string;
  host: string;
  port: number;
  username: string;
  password: string;
  label?: string | null;
};

type RotationState = {
  cursor: number;
  // endpoint id -> epoch ms until which it is set aside
  cooldowns: Map<string, number>;
};

type GlobalStore = { evmSmtpRotation?: Map<string, RotationState> };

const g = globalThis as unknown as GlobalStore;

function store(): Map<string, RotationState> {
  return (g.evmSmtpRotation ??= new Map());
}

const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const REPEATED_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

export function pickSmtpEndpoints<T extends RotatableEndpoint>(accessKeyId: string, all: T[]): T[] {
  const state = store().get(accessKeyId);
  const now = Date.now();
  return all.filter((e) => !state?.cooldowns.has(e.id) || (state!.cooldowns.get(e.id) || 0) <= now);
}

// Returns the endpoint to use next, skipping cooled-down ones. If every endpoint
// is cooling down, it returns the one whose cooldown expires soonest — a full
// outage is better than dropping the campaign, and the oldest cooldown is the
// most likely to have recovered.
export function nextSmtpEndpoint<T extends RotatableEndpoint>(accessKeyId: string, all: T[]): T | null {
  if (!all.length) return null;
  const map = store();
  const state = map.get(accessKeyId) ?? { cursor: 0, cooldowns: new Map() };
  map.set(accessKeyId, state);

  const now = Date.now();
  const usable = all.filter((e) => (state.cooldowns.get(e.id) || 0) <= now);
  if (usable.length) {
    // Pure round-robin: spread messages evenly so no single server carries
    // the whole batch.
    const pick = usable[state.cursor % usable.length];
    state.cursor = (state.cursor + 1) % usable.length;
    return pick;
  }
  // Everything is cooling down: pick the endpoint that recovers first.
  return [...usable.length ? usable : all].sort(
    (a, b) => (state.cooldowns.get(a.id) || 0) - (state.cooldowns.get(b.id) || 0),
  )[0];
}

// A send failed on this endpoint. Open the cooldown immediately so the rest of
// the batch moves to the other servers; a repeated failure (3rd consecutive at
// the DB layer, caller's judgement) cools it for longer.
export function penaliseSmtpEndpoint(accessKeyId: string, endpointId: string, repeated: boolean): void {
  const state = store().get(accessKeyId);
  if (!state) return;
  state.cooldowns.set(endpointId, Date.now() + (repeated ? REPEATED_FAILURE_COOLDOWN_MS : FAILURE_COOLDOWN_MS));
}

// A send succeeded: clear any cooldown so the endpoint rejoins the rotation.
export function rewardSmtpEndpoint(accessKeyId: string, endpointId: string): void {
  const state = store().get(accessKeyId);
  if (!state) return;
  state.cooldowns.delete(endpointId);
}

// Called when the endpoint set for a key changes (add/remove/toggle) so the
// cursor starts from a clean slate.
export function resetSmtpRotation(accessKeyId: string): void {
  store().delete(accessKeyId);
}
