/**
 * memphisDelegation — platform-side client + protocol logic for
 * "Memphis Delegated Sessions" (docs/memphis-delegated-sessions.md).
 *
 * The problem: a game runs in an opaque-origin sandbox, so it can neither
 * run WebAuthn nor (safely) be handed the platform's real Memphis session
 * token — that token is an anchor-level bearer credential; leaking it is a
 * full account takeover. The fix: the PLATFORM (top-level, where passkeys
 * work) mints a *delegated* token scoped to one audience (the game's
 * backend canister) with a short TTL, and hands the game only that.
 *
 * This file is the platform half. It is DORMANT by default
 * (`DELEGATION_ENABLED` is false unless `window.THEBES_DELEGATION === true`)
 * and depends on Memphis methods that ship on the chain branch
 * `feat/memphis-delegated-sessions`. Until both are live, a game simply
 * never receives a session — identical to today's behaviour.
 *
 * The two on-chain calls (`open_delegated_session`, `revoke_delegation`)
 * are made through the vendored passkey client's exposed low-level entry
 * `window.MemphisPasskey._memphisCallAwait(method, argBytes)`, so this
 * needs no fork of passkey.js. Candid encoding follows the exact
 * conventions passkey.js itself uses (see `encClaimNameArgs`): standard
 * opcodes, and — because this substrate has no Candid `principal` and
 * identifies apps by text (claim_name takes `location.origin` as text) —
 * the audience travels as the backend canister id's decimal STRING.
 */
import type { MemphisSession } from "./useMemphis";
import type { Game } from "./data";

/** Wire protocol version. Bump only on a breaking message-shape change. */
export const PROTOCOL_VERSION = 1;

/**
 * Delegated-token lifetime (approved §11: 15 min, silent re-issue). The
 * canister clamps to min(parent expiry, this) — this is the request.
 */
export const DELEGATION_TTL_NS = 15n * 60n * 1_000_000_000n;

/**
 * Master switch. Off unless a dev/operator opts in with
 * `window.THEBES_DELEGATION = true` before the app mounts. Keeps the whole
 * feature inert (no listeners, no calls) until the chain side is deployed.
 */
export const DELEGATION_ENABLED =
  typeof window !== "undefined" &&
  (window as unknown as { THEBES_DELEGATION?: boolean }).THEBES_DELEGATION ===
    true;

/**
 * The audience a delegation is scoped to = the game's BACKEND canister id
 * (approved §11.1). Returned as a string; null when the catalogue doesn't
 * declare one yet — in which case we cannot safely scope a delegation and
 * the game stays signed-out (honest fallback, not a stub).
 */
export function audienceFor(game: Game): string | null {
  return game.backendCid ?? null;
}

/* ─── per-game consent (approved §11.3: per-game, remembered) ─────────── */

const CONSENT_PREFIX = "thebes-games:deleg-consent:";

/** localStorage is per-origin; scope the key by the platform backend so a
    different app on the gateway can't read/clobber our consent set. */
function consentKey(gameSlug: string): string {
  const scope =
    (typeof window !== "undefined" &&
      (window as unknown as { MEMPHIS_SESSION_SCOPE?: string })
        .MEMPHIS_SESSION_SCOPE) ||
    "";
  return `${CONSENT_PREFIX}${scope}:${gameSlug}`;
}

export function hasConsent(gameSlug: string): boolean {
  try {
    return localStorage.getItem(consentKey(gameSlug)) === "1";
  } catch {
    return false;
  }
}

export function grantConsent(gameSlug: string): void {
  try {
    localStorage.setItem(consentKey(gameSlug), "1");
  } catch {
    /* private mode / storage disabled — treat as ask-again, never throw */
  }
}

/** Drop every remembered consent — call on platform sign-out. */
export function clearAllConsent(): void {
  try {
    const drop: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CONSENT_PREFIX)) drop.push(k);
    }
    for (const k of drop) localStorage.removeItem(k);
  } catch {
    /* fail-soft */
  }
}

/* ─── the wire messages ──────────────────────────────────────────────── */

export interface HelloMessage {
  v: number;
  type: "memphis:hello";
}
export interface RequestSignInMessage {
  v: number;
  type: "memphis:request-signin";
  channelId: string;
}
export interface GameSignOutMessage {
  v: number;
  type: "memphis:signout";
  channelId: string;
}
export type InboundMessage =
  | HelloMessage
  | RequestSignInMessage
  | GameSignOutMessage;

export interface SessionMessage {
  v: number;
  type: "memphis:session";
  channelId: string;
  /** DELEGATED token hex — never the anchor session token. */
  token: string;
  anchor: { display_tag: string; name?: string };
  expires_at_ns: string;
}
export interface SignedOutMessage {
  v: number;
  type: "memphis:signed-out";
  channelId: string;
}
export interface RevokedMessage {
  v: number;
  type: "memphis:revoked";
  channelId: string;
}
export type OutboundMessage =
  | SessionMessage
  | SignedOutMessage
  | RevokedMessage;

/**
 * Build the parent→frame session message. Takes the DELEGATED token only —
 * there is deliberately NO parameter for the real anchor token, so it is
 * structurally impossible for this builder to leak it (test T7). `anchor`
 * carries only display info (tag/name), never the token.
 */
export function buildSessionMessage(
  channelId: string,
  delegTokenHex: string,
  anchor: { display_tag: string; name?: string },
  expiresAtNs: string
): SessionMessage {
  return {
    v: PROTOCOL_VERSION,
    type: "memphis:session",
    channelId,
    token: delegTokenHex,
    anchor: { display_tag: anchor.display_tag, name: anchor.name },
    expires_at_ns: expiresAtNs,
  };
}

export function buildSignedOutMessage(channelId: string): SignedOutMessage {
  return { v: PROTOCOL_VERSION, type: "memphis:signed-out", channelId };
}

export function buildRevokedMessage(channelId: string): RevokedMessage {
  return { v: PROTOCOL_VERSION, type: "memphis:revoked", channelId };
}

/* ─── channel authentication ─────────────────────────────────────────── */

/**
 * A message is trusted only if it came from the game's own iframe window.
 * The frame is opaque-origin so `event.origin` is "null" and useless;
 * window-identity is the real check.
 */
export function isFromFrame(
  source: unknown,
  frameWindow: Window | null | undefined
): boolean {
  return !!frameWindow && source === frameWindow;
}

/** Parse an untrusted postMessage payload into a known inbound message. */
export function parseInbound(data: unknown): InboundMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.v !== PROTOCOL_VERSION || typeof m.type !== "string") return null;
  switch (m.type) {
    case "memphis:hello":
      return { v: PROTOCOL_VERSION, type: "memphis:hello" };
    case "memphis:request-signin":
      if (typeof m.channelId !== "string") return null;
      return {
        v: PROTOCOL_VERSION,
        type: "memphis:request-signin",
        channelId: m.channelId,
      };
    case "memphis:signout":
      if (typeof m.channelId !== "string") return null;
      return {
        v: PROTOCOL_VERSION,
        type: "memphis:signout",
        channelId: m.channelId,
      };
    default:
      return null;
  }
}

/* ─── the reducer (pure — the security core, unit-tested) ─────────────── */

export interface BridgeContext {
  channelId: string;
  signedIn: boolean;
  /** game.backendCid from the trusted catalogue — NEVER from the message. */
  audience: string | null;
  hasConsent: boolean;
}

export type BridgeAction =
  | { kind: "issue-session" }
  | { kind: "prompt-consent" }
  | { kind: "post-signed-out"; reason: string }
  | { kind: "open-signin" }
  | { kind: "revoke" }
  | { kind: "ignore"; reason: string };

/**
 * Decide what to do with an inbound message. Pure and deterministic so the
 * guarantees are testable:
 *  - the audience comes from `ctx`, never the message (G5 / test T9);
 *  - a game is only offered a session when signed in, scoped, and consented;
 *  - never emits the real token (that lives in the caller, post-issue).
 */
export function reduceGameMessage(
  msg: InboundMessage,
  ctx: BridgeContext
): BridgeAction {
  switch (msg.type) {
    case "memphis:hello":
    case "memphis:request-signin": {
      const wantsInteractive = msg.type === "memphis:request-signin";
      if (!ctx.signedIn) {
        return wantsInteractive
          ? { kind: "open-signin" }
          : { kind: "post-signed-out", reason: "platform not signed in" };
      }
      if (!ctx.audience) {
        return {
          kind: "post-signed-out",
          reason: "no backendCid for this game — cannot scope a delegation",
        };
      }
      if (!ctx.hasConsent) return { kind: "prompt-consent" };
      return { kind: "issue-session" };
    }
    case "memphis:signout":
      return { kind: "revoke" };
    default:
      return { kind: "ignore", reason: "unknown message type" };
  }
}

/* ─── Candid: encode args / decode reply for the two new Memphis calls ── */
//
// Minimal, self-contained (passkey.js's helpers aren't exported). Matches
// its conventions exactly: DIDL magic, standard opcodes, blob = vec nat8.

const MAGIC = [0x44, 0x49, 0x44, 0x4c];
// Standard Candid opcodes (sleb values): text -15, nat64 -8, vec -19,
// nat8 (blob element) -5. blob = vec nat8.
const TY = { TEXT: -15, BLOB_ELEM: -5, VEC: -19, NAT64: -8 };

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? "0" + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function uleb(n: bigint): number[] {
  const out: number[] = [];
  for (;;) {
    const byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n === 0n) return (out.push(byte), out);
    out.push(byte | 0x80);
  }
}
function sleb(nNum: number): number[] {
  let n = BigInt(nNum);
  const out: number[] = [];
  for (;;) {
    const byte = Number(n & 0x7fn);
    n >>= 7n;
    const done = (n === 0n && (byte & 0x40) === 0) || (n === -1n && (byte & 0x40) !== 0);
    if (done) return (out.push(byte), out);
    out.push(byte | 0x80);
  }
}
function readUleb(buf: Uint8Array, off: number): [bigint, number] {
  let r = 0n, s = 0n;
  for (;;) {
    const b = buf[off++];
    if (b === undefined) throw new Error("candid: truncated uleb");
    r |= BigInt(b & 0x7f) << s;
    if ((b & 0x80) === 0) return [r, off];
    s += 7n;
  }
}
function readSleb(buf: Uint8Array, off: number): [bigint, number] {
  let r = 0n, s = 0n;
  for (;;) {
    const b = buf[off++];
    if (b === undefined) throw new Error("candid: truncated sleb");
    r |= BigInt(b & 0x7f) << s;
    s += 7n;
    if ((b & 0x80) === 0) {
      if (b & 0x40) r -= 1n << s;
      return [r, off];
    }
  }
}

/**
 * Encode `open_delegated_session : (blob, text, nat64)` — the real session
 * token, the audience (backend cid decimal string), and the requested TTL.
 * Argument shape mirrors passkey.js `encClaimNameArgs` (one type-table
 * entry T0 = blob; args reference T0 then inline text/nat64).
 */
export function encOpenDelegatedArgs(
  sessionTokenHex: string,
  audienceCid: string,
  ttlNs: bigint
): Uint8Array {
  const token = hexToBytes(sessionTokenHex);
  const audience = new TextEncoder().encode(audienceCid);
  const out: number[] = [...MAGIC];
  out.push(...uleb(1n)); // 1 type-table entry
  out.push(...sleb(TY.VEC), ...sleb(TY.BLOB_ELEM)); // T0 = vec nat8
  out.push(...uleb(3n)); // 3 args
  out.push(...sleb(0)); // arg0 → T0 (blob)
  out.push(...sleb(TY.TEXT)); // arg1 text
  out.push(...sleb(TY.NAT64)); // arg2 nat64
  // values
  out.push(...uleb(BigInt(token.length)));
  for (const b of token) out.push(b);
  out.push(...uleb(BigInt(audience.length)));
  for (const b of audience) out.push(b);
  for (let i = 0n; i < 8n; i++) out.push(Number((ttlNs >> (i * 8n)) & 0xffn));
  return new Uint8Array(out);
}

/** Encode `revoke_delegation : (blob)`. */
export function encRevokeArgs(delegTokenHex: string): Uint8Array {
  const token = hexToBytes(delegTokenHex);
  const out: number[] = [...MAGIC];
  out.push(...uleb(1n));
  out.push(...sleb(TY.VEC), ...sleb(TY.BLOB_ELEM));
  out.push(...uleb(1n));
  out.push(...sleb(0));
  out.push(...uleb(BigInt(token.length)));
  for (const b of token) out.push(b);
  return new Uint8Array(out);
}

/** Candid field hash (the standard `h*223 + c mod 2^32`), matching
    passkey.js. Used to decode records in canonical (hash-sorted) order. */
function candidFieldHash(name: string): number {
  let h = 0n;
  for (const c of new TextEncoder().encode(name)) h = (h * 223n + BigInt(c)) & 0xffffffffn;
  return Number(h);
}

function skipTypeTable(u8: Uint8Array, off: number): number {
  let tts: bigint;
  [tts, off] = readUleb(u8, off);
  for (let i = 0n; i < tts; i++) {
    let code: bigint;
    [code, off] = readSleb(u8, off);
    if (code === -20n || code === -21n) {
      let cnt: bigint;
      [cnt, off] = readUleb(u8, off);
      for (let j = 0n; j < cnt; j++) {
        [, off] = readUleb(u8, off);
        [, off] = readSleb(u8, off);
      }
    } else if (code === -18n || code === -19n) {
      [, off] = readSleb(u8, off);
    }
  }
  let args: bigint;
  [args, off] = readUleb(u8, off);
  for (let i = 0n; i < args; i++) [, off] = readSleb(u8, off);
  return off;
}

export interface DelegationResult {
  delegTokenHex: string;
  expiresAtNs: string;
}

/**
 * Decode `variant { Ok : record { deleg_token: blob; expires_at_ns: nat64 };
 * Err : MemphisError }`. Fields arrive hash-sorted (Candid mandates it);
 * `deleg_token`/`expires_at_ns` are decoded in that order. Throws on Err.
 */
export function decodeDelegationReply(reply: Uint8Array): DelegationResult {
  if (
    reply.length < 4 ||
    reply[0] !== 0x44 ||
    reply[1] !== 0x49 ||
    reply[2] !== 0x44 ||
    reply[3] !== 0x4c
  ) {
    throw new Error("delegation reply: missing DIDL magic");
  }
  let off = skipTypeTable(reply, 4);
  let tag: bigint;
  [tag, off] = readUleb(reply, off);
  if (tag !== 0n) {
    // Err variant. We don't decode the specific MemphisError here.
    throw new Error("open_delegated_session rejected by Memphis");
  }
  // Ok record. Candid emits fields in ascending hash order; decode in that
  // order (don't assume which of the two names hashes lower — compute it).
  const fields = [
    { name: "deleg_token", kind: "blob" as const, hash: candidFieldHash("deleg_token") },
    { name: "expires_at_ns", kind: "nat64" as const, hash: candidFieldHash("expires_at_ns") },
  ].sort((a, b) => a.hash - b.hash);

  let delegTokenHex = "";
  let expiresAtNs = "0";
  for (const f of fields) {
    if (f.kind === "blob") {
      let len: bigint;
      [len, off] = readUleb(reply, off);
      delegTokenHex = bytesToHex(reply.slice(off, off + Number(len)));
      off += Number(len);
    } else {
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(reply[off + i]);
      off += 8;
      expiresAtNs = v.toString();
    }
  }
  return { delegTokenHex, expiresAtNs };
}

/* ─── the two on-chain calls (via the exposed passkey low-level entry) ── */

interface LowLevelPasskey {
  _memphisCallAwait: (method: string, argBytes: Uint8Array) => Promise<Uint8Array>;
}
function lowLevel(): LowLevelPasskey {
  const p = (window as unknown as { MemphisPasskey?: LowLevelPasskey })
    .MemphisPasskey;
  if (!p || typeof p._memphisCallAwait !== "function") {
    throw new Error("passkey.js not loaded — cannot reach Memphis");
  }
  return p;
}

/**
 * Mint a delegated session for `audienceCid`, proving authority with the
 * real `session`'s token (passed as a Candid arg, verified on-canister —
 * the token never rides the transport `sender`, same as claim_name).
 */
export async function openDelegatedSession(
  session: MemphisSession,
  audienceCid: string,
  ttlNs: bigint = DELEGATION_TTL_NS
): Promise<DelegationResult> {
  const args = encOpenDelegatedArgs(
    session.session_token_hex,
    audienceCid,
    ttlNs
  );
  const reply = await lowLevel()._memphisCallAwait("open_delegated_session", args);
  return decodeDelegationReply(reply);
}

/** Revoke a delegated token (best-effort; idempotent on-canister). */
export async function revokeDelegation(delegTokenHex: string): Promise<void> {
  await lowLevel()._memphisCallAwait("revoke_delegation", encRevokeArgs(delegTokenHex));
}
