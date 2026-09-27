// thebes.ts — minimal browser client for a Thebes backend canister.
//
// Talks the node HTTP surface the way the substrate's own dapps do
// (sample-dapp / memphis-client pattern):
//
//   query:  POST /api/query    { canister_id, method, arg, sender }
//   update: GET  /api/next_nonce?sender=…
//           POST /api/call     { canister_id, method, arg, sender, nonce }
//           GET  /api/receipt?hash=…   (poll until the chain finalizes)
//
// `arg` and `reply` are hex-encoded Candid bytes. This file hand-rolls
// exactly the Candid subset the starter backend uses — text, nat,
// nat64 — so the template has zero runtime dependencies. Grow it as
// your interface grows, or swap in a full Candid library later.

export const BACKEND_CANISTER_ID = 24874376952694;

// Same-origin when served from the chain via the boundary
// (/_/raw/<cid>/…). The Vite dev server proxies /api there too, so
// `npm run dev` works against the live network out of the box.
const BASE = "";

// ─── hex ─────────────────────────────────────────────────────────────

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? "0" + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ─── LEB128 (unsigned + signed) ──────────────────────────────────────

function uleb(n: bigint): number[] {
  const out: number[] = [];
  for (;;) {
    const byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n === 0n) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

function ulebDecode(buf: Uint8Array, off: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const byte = buf[off++];
    if (byte === undefined) throw new Error("candid: truncated uleb128");
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, off];
    shift += 7n;
  }
}

function slebDecode(buf: Uint8Array, off: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const byte = buf[off++];
    if (byte === undefined) throw new Error("candid: truncated sleb128");
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) {
      if (byte & 0x40) result -= 1n << shift; // sign-extend
      return [result, off];
    }
  }
}

// ─── Candid encode (the subset the starter needs) ────────────────────

const MAGIC = [0x44, 0x49, 0x44, 0x4c]; // "DIDL"
const TYPE_TEXT_SLEB = 0x71; // sleb128(-15), the `text` type code

/// Encode zero arguments: `()`.
export function encodeEmpty(): string {
  return bytesToHex(new Uint8Array([...MAGIC, 0, 0]));
}

/// Encode a single `(text)` argument.
export function encodeText(s: string): string {
  const utf8 = new TextEncoder().encode(s);
  return bytesToHex(
    new Uint8Array([
      ...MAGIC,
      0, // empty type table (primitives don't need entries)
      1, // one argument
      TYPE_TEXT_SLEB,
      ...uleb(BigInt(utf8.length)),
      ...utf8,
    ])
  );
}

// ─── Candid decode (text | nat | nat64) ──────────────────────────────

/// Decode a single-value Candid reply. Supports the primitive returns
/// the starter backend produces: text (0x71), nat (0x7d), nat64 (0x78).
export function decodeReply(hex: string): string | bigint {
  const buf = hexToBytes(hex);
  if (buf.length < 6 || buf[0] !== 0x44 || buf[1] !== 0x49 || buf[2] !== 0x44 || buf[3] !== 0x4c) {
    throw new Error("candid: bad magic in reply");
  }
  let off = 4;
  let tableCount: bigint;
  [tableCount, off] = ulebDecode(buf, off);
  if (tableCount !== 0n) {
    throw new Error(
      "candid: reply uses compound types; this starter client decodes primitives only — extend thebes.ts"
    );
  }
  let argCount: bigint;
  [argCount, off] = ulebDecode(buf, off);
  if (argCount === 0n) return "";
  let ty: bigint;
  [ty, off] = slebDecode(buf, off);
  switch (ty) {
    case -15n: {
      // text
      let len: bigint;
      [len, off] = ulebDecode(buf, off);
      return new TextDecoder().decode(buf.slice(off, off + Number(len)));
    }
    case -3n: {
      // nat
      const [v] = ulebDecode(buf, off);
      return v;
    }
    case -8n: {
      // nat64, 8 bytes little-endian
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[off + i]);
      return v;
    }
    default:
      throw new Error(`candid: unsupported reply type ${ty}; extend thebes.ts`);
  }
}

// ─── sender identity (demo-grade) ────────────────────────────────────
//
// Updates need a sender + nonce. This starter uses a random per-browser
// sender kept in localStorage — enough for the demo counter. For real
// user identity, integrate Memphis (the substrate's identity layer).

function demoSender(): string {
  // Scoped per backend cid. localStorage is per-ORIGIN, and every app on
  // the gateway shares one origin, so an unscoped key hands the SAME
  // sender to every project — their nonce sequences then interleave and
  // one app's submit gets rejected as a replay of another's.
  const KEY = `thebes-demo-sender:${BACKEND_CANISTER_ID}`;
  let s = localStorage.getItem(KEY);
  if (!s) {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    s = bytesToHex(b);
    localStorage.setItem(KEY, s);
  }
  return s;
}

// ─── transient-tolerant fetch ─────────────────────────────────────────
//
// The boundary fans out to a validator set; when one validator is
// briefly unreachable the gateway answers 502 with
// "validator unreachable". That is transient — the next attempt routes
// elsewhere. Retry a few times with backoff so a healthy cluster never
// surfaces a scary error to the user. Only idempotent reads and the
// pre-submit steps use this; the submitted update itself is never
// retried (that could double-execute), its receipt is polled instead.

const RETRIES = 3;

function isTransient(status: number, body: string): boolean {
  return (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /validator unreachable|no healthy validator|unhealthy/i.test(body)
  );
}

async function fetchWithRetry(url: string, init?: RequestInit): Promise<any> {
  let lastErr = "";
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    try {
      const r = await fetch(url, init);
      const text = await r.text();
      if (!r.ok && isTransient(r.status, text)) {
        lastErr = `HTTP ${r.status}: ${text.slice(0, 200)}`;
        continue;
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`malformed reply: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      // Network-level failure (DNS, connection reset) — also transient.
      lastErr = String(e);
    }
  }
  throw new Error(`the network is briefly unreachable — please try again (${lastErr})`);
}

// ─── nonce ownership ─────────────────────────────────────────────────
//
// The substrate's replay filter is a per-sender high-water mark, and its
// /api/next_nonce view LAGS finalization: right after a submit, the endpoint
// can still return the nonce we just used. Fetching next_nonce before every
// call therefore collides the moment calls come faster than blocks finalize —
// which a real publish does (a 400-file game is hundreds of put_chunks). The
// symptom is "nonce 102 already used (last seen: 102)".
//
// Fix: fetch next_nonce ONCE per sender to seed, then OWN the sequence with a
// local counter — every claim returns a distinct, monotonically increasing
// nonce with no network round-trip and no lag window. Gaps are fine (the
// substrate accepts any nonce above the high-water mark), so a rejected submit
// simply leaves a hole. On the rare genuine replay (e.g. another tab, or a
// stale seed) the chain names the real high-water mark and we jump past it.
//
// CRITICAL — the replay filter accepts a nonce only if it EXCEEDS the current
// high-water mark, so nonces must ARRIVE at the node in increasing order, not
// merely be distinct. A parallel upload that fires 135/136/137 at once can
// have 137 land first → the node sets hw=137 → 135 and 136 arrive after and
// are rejected FOREVER ("nonce 135 already used (last seen: 137)"). So the
// claim→submit critical section is serialized through one global queue: submits
// go out strictly in nonce order. Receipts are NOT serialized — they finalize
// in parallel, which is where an upload gets its throughput.

const nonceCounters = new Map<string, number>();
const nonceSeeding = new Map<string, Promise<void>>();

// Global submit queue — chains each claim→submit after the previous one so the
// node sees nonces in order. Errors are swallowed on the tail so one failed
// submit never wedges the chain.
let submitTail: Promise<unknown> = Promise.resolve();
function serializeSubmit<T>(fn: () => Promise<T>): Promise<T> {
  const result = submitTail.then(fn, fn);
  submitTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function claimNonce(sender: string): Promise<number> {
  if (!nonceCounters.has(sender)) {
    // Seed once, and dedupe concurrent first-claims so they share one fetch.
    let seeding = nonceSeeding.get(sender);
    if (!seeding) {
      seeding = (async () => {
        const nj = await fetchWithRetry(`${BASE}/api/next_nonce?sender=${sender}`, {
          cache: "no-store",
        });
        if (typeof nj.next_nonce !== "number") throw new Error("malformed next_nonce reply");
        if (!nonceCounters.has(sender)) nonceCounters.set(sender, nj.next_nonce);
      })();
      nonceSeeding.set(sender, seeding);
    }
    await seeding;
    nonceSeeding.delete(sender);
  }
  const n = nonceCounters.get(sender)!;
  nonceCounters.set(sender, n + 1);
  return n;
}

/** A replay rejection named the real high-water mark — jump the local counter
    past it and return the nonce to retry with. */
function reconcileNonce(sender: string, lastSeen: number): number {
  const next = lastSeen + 1;
  const cur = nonceCounters.get(sender) ?? next;
  nonceCounters.set(sender, Math.max(cur, next + 1));
  return next;
}

/** Ensure the next claimed nonce is at least `atLeast`. */
function bumpNonceTo(sender: string, atLeast: number): void {
  const cur = nonceCounters.get(sender) ?? atLeast;
  if (atLeast > cur) nonceCounters.set(sender, atLeast);
}

/** A nonce replay reported by the RECEIPT (execution time), not the submit.
    The submit was pooled at a nonce that the finalized high-water had already
    passed — so the call did NOT execute and is safe to re-submit. Carries the
    real high-water so the caller can jump the counter past it. */
class NonceReplayError extends Error {
  lastSeen: number;
  constructor(lastSeen: number) {
    super(`nonce replayed at execution (last seen: ${lastSeen})`);
    this.lastSeen = lastSeen;
  }
}

/** If `err` is a "nonce N already used (last seen: M)" string, return M. */
function replayHighWater(err: unknown): number | null {
  if (typeof err !== "string" || !/nonce .* already used/i.test(err)) return null;
  const m = err.match(/last seen:\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

/** Claim a nonce and get it onto the wire before the next claim (serialized,
    so arrivals stay ordered); on a replay rejection, jump past the named
    high-water mark and retry (bounded). Returns the node's queued response. */
function submitOwned(method: string, argHex: string, sender: string): Promise<any> {
  return serializeSubmit(async () => {
    let nonce = await claimNonce(sender);
    let j = await submitCall(method, argHex, sender, nonce);
    let tries = 0;
    while (
      !j.queued &&
      typeof j.error === "string" &&
      /nonce .* already used/i.test(j.error) &&
      tries < 8
    ) {
      tries++;
      const m = j.error.match(/last seen:\s*(\d+)/i);
      nonce = reconcileNonce(sender, m ? Number(m[1]) : nonce);
      j = await submitCall(method, argHex, sender, nonce);
    }
    return j;
  });
}

// ─── the three motions ───────────────────────────────────────────────

export async function query(method: string, argHex: string): Promise<string | bigint> {
  const j = await fetchWithRetry(`${BASE}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      canister_id: BACKEND_CANISTER_ID,
      method,
      arg: argHex,
      sender: demoSender(),
    }),
  });
  if (j.status !== "success") throw new Error(j.error || "query failed");
  return decodeReply(j.reply || "");
}

async function submitCall(
  method: string,
  argHex: string,
  sender: string,
  nonce: number
): Promise<any> {
  // The submit itself is deliberately NOT retried on a transient: a retry
  // after a submit that actually landed would execute the update twice.
  const r = await fetch(`${BASE}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      canister_id: BACKEND_CANISTER_ID,
      method,
      arg: argHex,
      sender,
      nonce,
    }),
  });
  const text = await r.text();
  if (!r.ok && isTransient(r.status, text)) {
    throw new Error("the network is briefly unreachable — please try again");
  }
  return JSON.parse(text);
}

export async function call(method: string, argHex: string): Promise<string | bigint> {
  const sender = demoSender();
  // Re-submit on an EXECUTION-time replay: a receipt reporting the nonce was
  // already used means the message never executed, so a fresh, higher nonce is
  // safe. (submitOwned already covers the submit-time replay.)
  for (let attempt = 0; ; attempt++) {
    const j = await submitOwned(method, argHex, sender);
    if (!j.queued || !j.message_hash) throw new Error(j.error || "call rejected");
    try {
      return await pollReceipt(j.message_hash);
    } catch (e) {
      if (e instanceof NonceReplayError && attempt < 8) {
        bumpNonceTo(sender, e.lastSeen + 1);
        continue;
      }
      throw e;
    }
  }
}

async function pollReceipt(hashHex: string): Promise<string | bigint> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    let j: any;
    try {
      j = await fetchWithRetry(`${BASE}/api/receipt?hash=${hashHex}`);
    } catch {
      // Transient (boundary 502, validator briefly unreachable) — the update
      // may still be in flight. Keep polling until the deadline; do NOT treat
      // a flaky gateway as a failed call.
      await new Promise((res) => setTimeout(res, 600));
      continue;
    }
    if (j.found) {
      if (j.status === "success") return decodeReply(j.reply || "");
      const hw = replayHighWater(j.error);
      if (hw !== null) throw new NonceReplayError(hw); // lost at execution — re-submit
      throw new Error(j.error || "call failed on chain"); // real on-chain failure
    }
    await new Promise((res) => setTimeout(res, 600));
  }
  throw new Error("timed out waiting for the chain's receipt");
}

// ─── raw variants ─────────────────────────────────────────────────────
//
// The typed helpers above decode primitive replies. The registry speaks
// compound Candid (records / variants / vec / blob), so registry.ts encodes
// args and decodes replies with @dfinity/candid and moves the bytes through
// these raw call/query paths (same retry / nonce / receipt discipline).

/** Query returning the raw reply hex (undecoded). */
export async function queryRaw(method: string, argHex: string): Promise<string> {
  const j = await fetchWithRetry(`${BASE}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      canister_id: BACKEND_CANISTER_ID,
      method,
      arg: argHex,
      sender: demoSender(),
    }),
  });
  if (j.status !== "success") throw new Error(j.error || "query failed");
  return j.reply || "";
}

async function pollReceiptRaw(hashHex: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    let j: any;
    try {
      j = await fetchWithRetry(`${BASE}/api/receipt?hash=${hashHex}`);
    } catch {
      await new Promise((res) => setTimeout(res, 600));
      continue;
    }
    if (j.found) {
      if (j.status === "success") return j.reply || "";
      const hw = replayHighWater(j.error);
      if (hw !== null) throw new NonceReplayError(hw); // lost at execution — re-submit
      throw new Error(j.error || "call failed on chain");
    }
    await new Promise((res) => setTimeout(res, 600));
  }
  throw new Error("timed out waiting for the chain's receipt");
}

/** Update returning the raw receipt reply hex (undecoded). */
export async function callRaw(method: string, argHex: string): Promise<string> {
  const sender = demoSender();
  // Re-submit on an EXECUTION-time replay (see call() above).
  for (let attempt = 0; ; attempt++) {
    const j = await submitOwned(method, argHex, sender);
    if (!j.queued || !j.message_hash) throw new Error(j.error || "call rejected");
    try {
      return await pollReceiptRaw(j.message_hash);
    } catch (e) {
      if (e instanceof NonceReplayError && attempt < 8) {
        bumpNonceTo(sender, e.lastSeen + 1);
        continue;
      }
      throw e;
    }
  }
}
