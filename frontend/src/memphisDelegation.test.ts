/**
 * Security-gate tests for Memphis Delegated Sessions
 * (docs/memphis-delegated-sessions.md §9). These are the FRONTEND release
 * gates — each asserts a concrete pass/fail, not "looks right":
 *
 *   T7  the real anchor token can never ride a frame message  (G1, no-leak)
 *   T8  messages from a non-frame window are rejected          (channel auth)
 *   T9  the audience comes from the catalogue, never the game  (G5)
 *
 * Plus reducer logic and a Candid encode→decode round-trip for the two new
 * Memphis calls, so a wire-format regression fails here rather than on-chain.
 */
import { describe, it, expect } from "vitest";
import type { Game } from "./data";
import {
  PROTOCOL_VERSION,
  audienceFor,
  buildSessionMessage,
  isFromFrame,
  parseInbound,
  reduceGameMessage,
  encOpenDelegatedArgs,
  decodeDelegationReply,
  type BridgeContext,
  type InboundMessage,
} from "./memphisDelegation";

const CHANNEL = "abcd1234";

function ctx(over: Partial<BridgeContext> = {}): BridgeContext {
  return {
    channelId: CHANNEL,
    signedIn: true,
    audience: "555000",
    hasConsent: true,
    ...over,
  };
}

/* ── T7 — the real token never leaves the platform ─────────────────────── */

describe("T7 no-leak: session message carries only the delegated token", () => {
  it("contains the delegated token and NOT the real anchor token", () => {
    const realToken = "dead".repeat(16); // the secret we must never ship
    const delegToken = "beef".repeat(16);
    const msg = buildSessionMessage(
      CHANNEL,
      delegToken,
      { display_tag: "a1b2", name: "meritamun.thebes" },
      "1700000000000000000"
    );
    const wire = JSON.stringify(msg);
    expect(wire).toContain(delegToken);
    expect(wire).not.toContain(realToken);
    // The message shape has no field that could smuggle the real token.
    expect(msg.token).toBe(delegToken);
    expect(Object.keys(msg.anchor).sort()).toEqual(["display_tag", "name"]);
  });

  it("buildSessionMessage has no parameter for the real token (structural)", () => {
    // 4 params: channelId, delegToken, anchor, expiry — no real-token slot.
    expect(buildSessionMessage.length).toBe(4);
  });
});

/* ── T8 — channel authentication by window identity ────────────────────── */

describe("T8 channel auth: only the game frame's window is trusted", () => {
  const frame = { name: "frame" } as unknown as Window;
  const other = { name: "other" } as unknown as Window;

  it("accepts a message whose source is the frame window", () => {
    expect(isFromFrame(frame, frame)).toBe(true);
  });
  it("rejects a message from any other window", () => {
    expect(isFromFrame(other, frame)).toBe(false);
  });
  it("rejects when there is no frame window", () => {
    expect(isFromFrame(frame, null)).toBe(false);
    expect(isFromFrame(frame, undefined)).toBe(false);
  });
});

/* ── T9 — audience is chosen by the platform, not the game ─────────────── */

describe("T9 audience binding: the game cannot widen its own scope", () => {
  it("parseInbound strips any extra fields a game injects (e.g. backendCid)", () => {
    const hostile = {
      v: PROTOCOL_VERSION,
      type: "memphis:hello",
      backendCid: "999999", // a forged audience the game would love us to use
      token: "should-be-ignored",
    };
    const parsed = parseInbound(hostile);
    expect(parsed).toEqual({ v: PROTOCOL_VERSION, type: "memphis:hello" });
    expect(parsed && "backendCid" in parsed).toBe(false);
  });

  it("reducer decides issue-session from ctx.audience only", () => {
    const hello: InboundMessage = { v: PROTOCOL_VERSION, type: "memphis:hello" };
    // The message can't carry an audience; the reducer reads ctx.audience.
    expect(reduceGameMessage(hello, ctx({ audience: "555000" })).kind).toBe(
      "issue-session"
    );
    // No audience in ctx → cannot scope → signed-out, never issue.
    expect(reduceGameMessage(hello, ctx({ audience: null })).kind).toBe(
      "post-signed-out"
    );
  });

  it("audienceFor reads backendCid from the catalogue entry", () => {
    const g = { backendCid: "555000" } as Game;
    expect(audienceFor(g)).toBe("555000");
    expect(audienceFor({} as Game)).toBeNull();
  });
});

/* ── reducer logic ─────────────────────────────────────────────────────── */

describe("reduceGameMessage", () => {
  const hello: InboundMessage = { v: PROTOCOL_VERSION, type: "memphis:hello" };
  const req: InboundMessage = {
    v: PROTOCOL_VERSION,
    type: "memphis:request-signin",
    channelId: CHANNEL,
  };

  it("hello + signed in + consent + audience → issue", () => {
    expect(reduceGameMessage(hello, ctx()).kind).toBe("issue-session");
  });
  it("hello + signed in + audience + no consent → prompt", () => {
    expect(reduceGameMessage(hello, ctx({ hasConsent: false })).kind).toBe(
      "prompt-consent"
    );
  });
  it("hello + not signed in → signed-out (non-interactive)", () => {
    expect(reduceGameMessage(hello, ctx({ signedIn: false })).kind).toBe(
      "post-signed-out"
    );
  });
  it("request-signin + not signed in → open the platform sign-in", () => {
    expect(reduceGameMessage(req, ctx({ signedIn: false })).kind).toBe(
      "open-signin"
    );
  });
  it("signout → revoke", () => {
    const m: InboundMessage = {
      v: PROTOCOL_VERSION,
      type: "memphis:signout",
      channelId: CHANNEL,
    };
    expect(reduceGameMessage(m, ctx()).kind).toBe("revoke");
  });
});

/* ── parseInbound validation ───────────────────────────────────────────── */

describe("parseInbound", () => {
  it("rejects non-objects and wrong protocol version", () => {
    expect(parseInbound(null)).toBeNull();
    expect(parseInbound("hello")).toBeNull();
    expect(parseInbound({ v: 999, type: "memphis:hello" })).toBeNull();
    expect(parseInbound({ type: "memphis:hello" })).toBeNull();
  });
  it("requires channelId on request-signin / signout", () => {
    expect(
      parseInbound({ v: PROTOCOL_VERSION, type: "memphis:request-signin" })
    ).toBeNull();
    expect(
      parseInbound({
        v: PROTOCOL_VERSION,
        type: "memphis:signout",
        channelId: "x",
      })
    ).toEqual({ v: PROTOCOL_VERSION, type: "memphis:signout", channelId: "x" });
  });
  it("rejects unknown message types", () => {
    expect(parseInbound({ v: PROTOCOL_VERSION, type: "memphis:evil" })).toBeNull();
  });
});

/* ── Candid encode/decode round-trip ───────────────────────────────────── */

describe("Candid wire format for the two new Memphis calls", () => {
  it("encOpenDelegatedArgs emits DIDL and embeds token + audience + ttl", () => {
    const args = encOpenDelegatedArgs("00ff10", "24874376952694", 900n);
    // DIDL magic
    expect(Array.from(args.slice(0, 4))).toEqual([0x44, 0x49, 0x44, 0x4c]);
    // token bytes present
    expect(indexOfBytes(args, [0x00, 0xff, 0x10])).toBeGreaterThan(-1);
    // audience text present
    const aud = Array.from(new TextEncoder().encode("24874376952694"));
    expect(indexOfBytes(args, aud)).toBeGreaterThan(-1);
    // ttl 900 as nat64 LE present (0x84,0x03,0,0,0,0,0,0)
    expect(indexOfBytes(args, [0x84, 0x03, 0, 0, 0, 0, 0, 0])).toBeGreaterThan(-1);
  });

  it("decodeDelegationReply round-trips a canonical Ok reply", () => {
    const token = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
    const expires = 1730000000000000000n;
    const reply = buildOkDelegationReply(token, expires);
    const out = decodeDelegationReply(reply);
    expect(out.delegTokenHex).toBe("cafebabe");
    expect(out.expiresAtNs).toBe(expires.toString());
  });

  it("decodeDelegationReply throws on an Err reply", () => {
    expect(() => decodeDelegationReply(buildErrDelegationReply())).toThrow();
  });
});

/* ── test helpers: hand-built Candid replies matching the canister shape ── */

function candidFieldHash(name: string): number {
  let h = 0n;
  for (const c of new TextEncoder().encode(name))
    h = (h * 223n + BigInt(c)) & 0xffffffffn;
  return Number(h);
}
function uleb(n: bigint): number[] {
  const out: number[] = [];
  for (;;) {
    const b = Number(n & 0x7fn);
    n >>= 7n;
    if (n === 0n) return (out.push(b), out);
    out.push(b | 0x80);
  }
}
function sleb(nNum: number): number[] {
  let n = BigInt(nNum);
  const out: number[] = [];
  for (;;) {
    const b = Number(n & 0x7fn);
    n >>= 7n;
    const done =
      (n === 0n && (b & 0x40) === 0) || (n === -1n && (b & 0x40) !== 0);
    if (done) return (out.push(b), out);
    out.push(b | 0x80);
  }
}
function nat64le(v: bigint): number[] {
  const out: number[] = [];
  for (let i = 0n; i < 8n; i++) out.push(Number((v >> (i * 8n)) & 0xffn));
  return out;
}

/**
 * Emit a real Candid reply for
 *   variant { Ok : record { deleg_token: blob; expires_at_ns: nat64 }; Err: text }
 * with the Ok arm selected — exercising skipTypeTable + the value walker.
 */
function buildOkDelegationReply(token: Uint8Array, expires: bigint): Uint8Array {
  const recFields = [
    { name: "deleg_token", ref: 0 },
    { name: "expires_at_ns", ref: -8 },
  ]
    .map((f) => ({ ...f, hash: candidFieldHash(f.name) }))
    .sort((a, b) => a.hash - b.hash);

  const varFields = [
    { name: "Ok", ref: 1 },
    { name: "Err", ref: -15 },
  ]
    .map((f) => ({ ...f, hash: candidFieldHash(f.name) }))
    .sort((a, b) => a.hash - b.hash);
  const okIndex = varFields.findIndex((f) => f.name === "Ok");

  const out: number[] = [0x44, 0x49, 0x44, 0x4c];
  out.push(...uleb(3n)); // 3 type-table entries
  // T0 = vec nat8 (blob)
  out.push(...sleb(-19), ...sleb(-5));
  // T1 = record { … }
  out.push(...sleb(-20), ...uleb(BigInt(recFields.length)));
  for (const f of recFields) out.push(...uleb(BigInt(f.hash)), ...sleb(f.ref));
  // T2 = variant { Ok : T1; Err : text }
  out.push(...sleb(-21), ...uleb(BigInt(varFields.length)));
  for (const f of varFields)
    out.push(...uleb(BigInt(f.hash)), ...sleb(f.name === "Ok" ? 1 : f.ref));
  // one arg of type T2
  out.push(...uleb(1n), ...sleb(2));
  // value: variant tag = Ok index, then the record fields in hash order
  out.push(...uleb(BigInt(okIndex)));
  for (const f of recFields) {
    if (f.name === "deleg_token")
      out.push(...uleb(BigInt(token.length)), ...token);
    else out.push(...nat64le(expires));
  }
  return new Uint8Array(out);
}

function buildErrDelegationReply(): Uint8Array {
  const varFields = [
    { name: "Ok", ref: 1 },
    { name: "Err", ref: -15 },
  ]
    .map((f) => ({ ...f, hash: candidFieldHash(f.name) }))
    .sort((a, b) => a.hash - b.hash);
  const errIndex = varFields.findIndex((f) => f.name === "Err");

  const out: number[] = [0x44, 0x49, 0x44, 0x4c];
  out.push(...uleb(3n));
  out.push(...sleb(-19), ...sleb(-5));
  out.push(...sleb(-20), ...uleb(2n));
  for (const f of [
    { name: "deleg_token", ref: 0 },
    { name: "expires_at_ns", ref: -8 },
  ]
    .map((f) => ({ ...f, hash: candidFieldHash(f.name) }))
    .sort((a, b) => a.hash - b.hash))
    out.push(...uleb(BigInt(f.hash)), ...sleb(f.ref));
  out.push(...sleb(-21), ...uleb(2n));
  for (const f of varFields)
    out.push(...uleb(BigInt(f.hash)), ...sleb(f.name === "Ok" ? 1 : f.ref));
  out.push(...uleb(1n), ...sleb(2));
  // value: Err arm with a text payload
  out.push(...uleb(BigInt(errIndex)));
  const msg = new TextEncoder().encode("Expired");
  out.push(...uleb(BigInt(msg.length)), ...msg);
  return new Uint8Array(out);
}

function indexOfBytes(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
