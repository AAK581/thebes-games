/**
 * registry.ts — typed client for the on-chain registry + vault (backend
 * canister). Encodes args / decodes replies with @dfinity/candid (the
 * substrate speaks standard Candid) and moves the hex through thebes.ts's
 * raw call/query paths.
 *
 * Surface (mirrors backend/Backend.mo exactly):
 *   begin_publish : (blob, GameMeta)              -> variant { ok:text; err:text }
 *   put_chunk     : (blob, text, text, blob)      -> variant { ok:nat;  err:text }
 *   finish_publish: (blob, text)                  -> variant { ok:text; err:text }
 *   update_game   : (blob, text, GameMeta)        -> variant { ok;      err:text }
 *   unpublish     : (blob, text)                  -> variant { ok;      err:text }
 *   adopt_game    : (blob, text)                  -> variant { ok;      err:text }
 *   clear_cover   : (blob, text)                  -> variant { ok;      err:text }
 *   adoptable_games: ()                           -> vec GameView          (query)
 *   catalogue     : ()                            -> vec GameView          (query)
 *   game          : (text)                        -> opt GameView          (query)
 */
import { IDL } from "@dfinity/candid";
import { BACKEND_CANISTER_ID, callRaw, queryRaw } from "./thebes";
import type { Game, Rating } from "./data";

/** The vault canister id — vault games serve at /_/raw/<VAULT_CID>/g/<slug>/. */
export const VAULT_CID = String(BACKEND_CANISTER_ID);

// ─── Candid types (match Backend.mo) ─────────────────────────────────────

const RatingT = IDL.Variant({ E: IDL.Null, T: IDL.Null, M: IDL.Null });
const SourceT = IDL.Variant({ vault: IDL.Null, canister: IDL.Text });
const StatusT = IDL.Variant({
  live: IDL.Null,
  quarantined: IDL.Record({ caseId: IDL.Nat }),
});
const BlobT = IDL.Vec(IDL.Nat8);
const GameMetaT = IDL.Record({
  title: IDL.Text,
  tagline: IDL.Text,
  description: IDL.Text,
  tags: IDL.Vec(IDL.Text),
  rating: RatingT,
  resW: IDL.Opt(IDL.Nat),
  resH: IDL.Opt(IDL.Nat),
});
const GameViewT = IDL.Record({
  slug: IDL.Text,
  title: IDL.Text,
  tagline: IDL.Text,
  description: IDL.Text,
  tags: IDL.Vec(IDL.Text),
  rating: RatingT,
  owner: IDL.Text,
  source: SourceT,
  sizeBytes: IDL.Nat,
  updatedAtNs: IDL.Nat64,
  status: StatusT,
  plays: IDL.Nat,
  favorites: IDL.Nat,
  cover: IDL.Bool,
  shots: IDL.Nat,
  resW: IDL.Nat,
  resH: IDL.Nat,
});
const LogEntryT = IDL.Record({
  atNs: IDL.Nat64,
  action: IDL.Text,
  target: IDL.Text,
  who: IDL.Text,
  detail: IDL.Text,
  caseId: IDL.Nat,
});
const CaseViewT = IDL.Record({
  id: IDL.Nat,
  slug: IDL.Text,
  kind: IDL.Text,
  openedAtNs: IDL.Nat64,
  restoreVotes: IDL.Nat,
  delistVotes: IDL.Nat,
  resolved: IDL.Opt(IDL.Text),
});
const ResText = IDL.Variant({ ok: IDL.Text, err: IDL.Text });
const ResNat = IDL.Variant({ ok: IDL.Nat, err: IDL.Text });
const ResBool = IDL.Variant({ ok: IDL.Bool, err: IDL.Text });
const ResUnit = IDL.Variant({ ok: IDL.Null, err: IDL.Text });

// ─── hex + codec helpers ─────────────────────────────────────────────────

function toHex(u8: Uint8Array): string {
  return Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 ? "0" + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function enc(types: any[], vals: unknown[]): string {
  return toHex(new Uint8Array(IDL.encode(types, vals)));
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dec(types: any[], hex: string): unknown[] {
  return IDL.decode(types, fromHex(hex));
}

function ratingVariant(r: Rating): Record<string, null> {
  return r === "E" ? { E: null } : r === "T" ? { T: null } : { M: null };
}
function ratingOf(v: Record<string, unknown>): Rating {
  return "E" in v ? "E" : "T" in v ? "T" : "M";
}

/** Throw on the `err` arm, return the `ok` payload otherwise. */
function unwrap<T>(res: unknown, what: string): T {
  const r = res as { ok?: T; err?: string };
  if (r && "ok" in r) return r.ok as T;
  throw new Error((r && r.err) || `${what} failed`);
}

export interface MetaInput {
  title: string;
  tagline: string;
  description: string;
  tags: string[];
  rating: Rating;
  resW: number;
  resH: number;
}

/** MetaInput → the GameMeta wire record (resolution as opt nat). */
function metaRecord(m: MetaInput) {
  return {
    title: m.title,
    tagline: m.tagline,
    description: m.description,
    tags: m.tags,
    rating: ratingVariant(m.rating),
    resW: [BigInt(Math.round(m.resW))],
    resH: [BigInt(Math.round(m.resH))],
  };
}

// ─── publish (auth-gated, chunked) ───────────────────────────────────────

export async function beginPublish(
  tokenHex: string,
  m: MetaInput
): Promise<string> {
  const args = enc([BlobT, GameMetaT], [fromHex(tokenHex), metaRecord(m)]);
  const [res] = dec([ResText], await callRaw("begin_publish", args));
  return unwrap<string>(res, "begin_publish");
}

/** Owner-only metadata edit for a published game — title/tagline/description/
    tags/rating/resolution, no re-upload. The slug (shelf address) never
    changes; bytes change by re-publishing, the cover via setCover. */
export async function updateGame(
  tokenHex: string,
  slug: string,
  m: MetaInput
): Promise<void> {
  const args = enc(
    [BlobT, IDL.Text, GameMetaT],
    [fromHex(tokenHex), slug, metaRecord(m)]
  );
  const [res] = dec([ResUnit], await callRaw("update_game", args));
  unwrap<null>(res, "update_game");
}

export async function putChunk(
  tokenHex: string,
  slug: string,
  path: string,
  bytes: Uint8Array
): Promise<bigint> {
  const args = enc(
    [BlobT, IDL.Text, IDL.Text, BlobT],
    [fromHex(tokenHex), slug, path, bytes]
  );
  const [res] = dec([ResNat], await callRaw("put_chunk", args));
  return unwrap<bigint>(res, "put_chunk");
}

export async function finishPublish(
  tokenHex: string,
  slug: string
): Promise<string> {
  const args = enc([BlobT, IDL.Text], [fromHex(tokenHex), slug]);
  const [res] = dec([ResText], await callRaw("finish_publish", args));
  return unwrap<string>(res, "finish_publish");
}

export async function unpublish(tokenHex: string, slug: string): Promise<void> {
  const args = enc([BlobT, IDL.Text], [fromHex(tokenHex), slug]);
  const [res] = dec([ResUnit], await callRaw("unpublish", args));
  unwrap<null>(res, "unpublish");
}

// ─── catalogue (public queries) ──────────────────────────────────────────

export async function catalogue(): Promise<Game[]> {
  const [views] = dec([IDL.Vec(GameViewT)], await queryRaw("catalogue", enc([], [])));
  return (views as Record<string, unknown>[]).map(toGame);
}

export async function getGame(slug: string): Promise<Game | null> {
  const [opt] = dec([IDL.Opt(GameViewT)], await queryRaw("game", enc([IDL.Text], [slug])));
  const arr = opt as Record<string, unknown>[];
  return arr.length ? toGame(arr[0]) : null;
}

// ─── mapping: on-chain GameView → the frontend Game shape ────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toGame(v: any): Game {
  const canisterCid = "canister" in v.source ? (v.source.canister as string) : undefined;
  const vaultSlug = "vault" in v.source ? (v.slug as string) : undefined;
  const quarantined = "quarantined" in v.status;
  const sizeBytes = Number(v.sizeBytes as bigint);
  const updatedNs = v.updatedAtNs as bigint;
  return {
    slug: v.slug,
    title: v.title,
    tagline: v.tagline,
    description: v.description,
    owner: v.owner,
    tags: v.tags,
    rating: ratingOf(v.rating),
    status: quarantined ? "quarantined" : "live",
    caseId: quarantined ? Number(v.status.quarantined.caseId) : undefined,
    // Fields the registry doesn't track yet (plays/favorites/version) get
    // honest placeholders — the chip already says "registry pending".
    version: "1.0.0",
    sizeMB: sizeBytes / (1024 * 1024),
    updated:
      updatedNs > 0n
        ? new Date(Number(updatedNs / 1_000_000n)).toISOString().slice(0, 10)
        : "just now",
    plays: Number(v.plays as bigint),
    favorites: Number(v.favorites as bigint),
    cid: canisterCid,
    vaultSlug,
    coverUrl: v.cover ? `/_/raw/${VAULT_CID}/g/${v.slug}/__cover` : undefined,
    shotUrls: Array.from({ length: Number(v.shots as bigint) }, (_, i) =>
      shotUrl(v.slug as string, i)
    ),
    resW: Number(v.resW as bigint),
    resH: Number(v.resH as bigint),
  };
}

function nsToDate(ns: bigint): string {
  return ns > 0n
    ? new Date(Number(ns / 1_000_000n)).toISOString().slice(0, 10)
    : "just now";
}

// ─── engagement + manage ─────────────────────────────────────────────────

export async function recordPlay(slug: string): Promise<void> {
  await callRaw("record_play", enc([IDL.Text], [slug]));
}

export async function toggleFavorite(tokenHex: string, slug: string): Promise<boolean> {
  const [res] = dec([ResBool], await callRaw("toggle_favorite", enc([BlobT, IDL.Text], [fromHex(tokenHex), slug])));
  return unwrap<boolean>(res, "toggle_favorite");
}

export async function isFavorite(tokenHex: string, slug: string): Promise<boolean> {
  const [b] = dec([IDL.Bool], await callRaw("is_favorite", enc([BlobT, IDL.Text], [fromHex(tokenHex), slug])));
  return b as boolean;
}

export async function myGames(tokenHex: string): Promise<Game[]> {
  const [views] = dec([IDL.Vec(GameViewT)], await callRaw("my_games", enc([BlobT], [fromHex(tokenHex)])));
  return (views as Record<string, unknown>[]).map(toGame);
}

// Matches the game-file chunk size — small enough that one call body stays well
// under the node's inline ingress ceiling (a whole-image set_cover call 413s).
const COVER_CHUNK = 32 * 1000;

export async function setCover(
  tokenHex: string,
  slug: string,
  contentType: string,
  bytes: Uint8Array
): Promise<void> {
  if (bytes.length === 0) return;
  const token = fromHex(tokenHex);
  // Chunked upload: send the image in pieces (serialized + nonce-safe via
  // callRaw), then commit — the backend assembles them into the region.
  for (let off = 0; off < bytes.length; off += COVER_CHUNK) {
    const chunk = bytes.subarray(off, Math.min(off + COVER_CHUNK, bytes.length));
    const [res] = dec([ResNat], await callRaw("cover_chunk", enc([BlobT, IDL.Text, BlobT], [token, slug, chunk])));
    unwrap<bigint>(res, "cover_chunk");
  }
  const [res] = dec([ResUnit], await callRaw("cover_commit", enc([BlobT, IDL.Text, IDL.Text], [token, slug, contentType])));
  unwrap<null>(res, "cover_commit");
}

// ─── screenshots ─────────────────────────────────────────────────────────

/** Where screenshot `i` of a game is served. */
export function shotUrl(slug: string, i: number): string {
  return `/_/raw/${VAULT_CID}/g/${slug}/__shot/${i}`;
}

/** The backend's gallery cap — the UI stops offering "add" at this count. */
export const MAX_SHOTS = 6;

/** Append a screenshot (owner only), chunked like a cover. Returns the new count. */
export async function addShot(
  tokenHex: string,
  slug: string,
  contentType: string,
  bytes: Uint8Array
): Promise<number> {
  if (bytes.length === 0) throw new Error("empty screenshot");
  const token = fromHex(tokenHex);
  for (let off = 0; off < bytes.length; off += COVER_CHUNK) {
    const chunk = bytes.subarray(off, Math.min(off + COVER_CHUNK, bytes.length));
    const [res] = dec([ResNat], await callRaw("shot_chunk", enc([BlobT, IDL.Text, BlobT], [token, slug, chunk])));
    unwrap<bigint>(res, "shot_chunk");
  }
  const [res] = dec([ResNat], await callRaw("shot_commit", enc([BlobT, IDL.Text, IDL.Text], [token, slug, contentType])));
  return Number(unwrap<bigint>(res, "shot_commit"));
}

/** Remove screenshot `index` (owner only). Returns the remaining count. */
export async function removeShot(tokenHex: string, slug: string, index: number): Promise<number> {
  const [res] = dec(
    [ResNat],
    await callRaw("remove_shot", enc([BlobT, IDL.Text, IDL.Nat], [fromHex(tokenHex), slug, BigInt(index)]))
  );
  return Number(unwrap<bigint>(res, "remove_shot"));
}

/** Remove a game's cover (owner only) — the shelf falls back to generated art. */
export async function clearCover(tokenHex: string, slug: string): Promise<void> {
  const [res] = dec([ResUnit], await callRaw("clear_cover", enc([BlobT, IDL.Text], [fromHex(tokenHex), slug])));
  unwrap<null>(res, "clear_cover");
}

// ─── house games (the seeded staff listings) ─────────────────────────────
//
// The three seeds were created with an empty owner anchor, so no account could
// edit them. The platform owner adopts one to bind edit rights to their anchor;
// the public byline keeps reading "thebes".

export async function adoptableGames(): Promise<Game[]> {
  const [views] = dec([IDL.Vec(GameViewT)], await queryRaw("adoptable_games", enc([], [])));
  return (views as Record<string, unknown>[]).map(toGame);
}

export async function adoptGame(tokenHex: string, slug: string): Promise<void> {
  const [res] = dec([ResUnit], await callRaw("adopt_game", enc([BlobT, IDL.Text], [fromHex(tokenHex), slug])));
  unwrap<null>(res, "adopt_game");
}

export async function amIOwner(tokenHex: string): Promise<boolean> {
  const [b] = dec([IDL.Bool], await callRaw("am_i_owner", enc([BlobT], [fromHex(tokenHex)])));
  return b as boolean;
}

/** Owner-only: appoint a curator by their Memphis anchor id. */
export async function addCurator(tokenHex: string, anchor: Uint8Array): Promise<void> {
  const [res] = dec([ResUnit], await callRaw("add_curator", enc([BlobT, BlobT], [fromHex(tokenHex), anchor])));
  unwrap<null>(res, "add_curator");
}

// ─── usernames (the public gaming handle) ────────────────────────────────
//
// The Memphis name is an identity (kareem.thebes); the username is what
// bylines and the mod log show. Unique case-insensitively, enforced on-chain.

const UsernameCheckT = IDL.Variant({ free: IDL.Null, taken: IDL.Null, invalid: IDL.Text });

export type UsernameCheck =
  | { state: "free" }
  | { state: "taken" }
  | { state: "invalid"; reason: string };

export async function setUsername(tokenHex: string, username: string): Promise<void> {
  const [res] = dec([ResUnit], await callRaw("set_username", enc([BlobT, IDL.Text], [fromHex(tokenHex), username])));
  unwrap<null>(res, "set_username");
}

export async function myUsername(tokenHex: string): Promise<string | null> {
  const [opt] = dec([IDL.Opt(IDL.Text)], await callRaw("my_username", enc([BlobT], [fromHex(tokenHex)])));
  const arr = opt as string[];
  return arr.length ? arr[0] : null;
}

/** Reverse lookup: gaming handle → anchor id (case-insensitive), or null. */
export async function anchorForUsername(username: string): Promise<Uint8Array | null> {
  const [opt] = dec([IDL.Opt(BlobT)], await queryRaw("anchor_for_username", enc([IDL.Text], [username])));
  const arr = opt as number[][];
  return arr.length ? Uint8Array.from(arr[0]) : null;
}

export async function usernameCheck(username: string): Promise<UsernameCheck> {
  const [v] = dec([UsernameCheckT], await queryRaw("username_check", enc([IDL.Text], [username])));
  const r = v as Record<string, unknown>;
  if ("free" in r) return { state: "free" };
  if ("taken" in r) return { state: "taken" };
  return { state: "invalid", reason: String(r.invalid) };
}

// ─── moderation ──────────────────────────────────────────────────────────

export async function report(tokenHex: string, slug: string, reason: string): Promise<void> {
  const [res] = dec([ResText], await callRaw("report", enc([BlobT, IDL.Text, IDL.Text], [fromHex(tokenHex), slug, reason])));
  unwrap<string>(res, "report");
}

export async function emergencyFreeze(tokenHex: string, slug: string, reason: string): Promise<void> {
  const [res] = dec([ResNat], await callRaw("emergency_freeze", enc([BlobT, IDL.Text, IDL.Text], [fromHex(tokenHex), slug, reason])));
  unwrap<bigint>(res, "emergency_freeze");
}

export async function vote(tokenHex: string, caseId: number, restore: boolean): Promise<void> {
  const [res] = dec([ResText], await callRaw("vote", enc([BlobT, IDL.Nat, IDL.Bool], [fromHex(tokenHex), BigInt(caseId), restore])));
  unwrap<string>(res, "vote");
}

export async function amICurator(tokenHex: string): Promise<boolean> {
  const [b] = dec([IDL.Bool], await callRaw("am_i_curator", enc([BlobT], [fromHex(tokenHex)])));
  return b as boolean;
}

export async function claimOwner(tokenHex: string): Promise<void> {
  const [res] = dec([ResUnit], await callRaw("claim_owner", enc([BlobT], [fromHex(tokenHex)])));
  unwrap<null>(res, "claim_owner");
}

export interface ModLogEntry {
  at: string;
  action: string;
  target: string;
  who: string;
  detail: string;
  caseId: number;
}

export async function modLog(): Promise<ModLogEntry[]> {
  const [entries] = dec([IDL.Vec(LogEntryT)], await queryRaw("mod_log", enc([], [])));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (entries as any[]).map((e) => ({
    at: nsToDate(e.atNs),
    action: e.action,
    target: e.target,
    who: e.who,
    detail: e.detail,
    caseId: Number(e.caseId),
  }));
}

export interface OpenCase {
  id: number;
  slug: string;
  kind: string;
  opened: string;
  restoreVotes: number;
  delistVotes: number;
  resolved: string | null;
}

export async function openCases(): Promise<OpenCase[]> {
  const [cs] = dec([IDL.Vec(CaseViewT)], await queryRaw("open_cases", enc([], [])));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (cs as any[]).map((c) => ({
    id: Number(c.id),
    slug: c.slug,
    kind: c.kind,
    opened: nsToDate(c.openedAtNs),
    restoreVotes: Number(c.restoreVotes),
    delistVotes: Number(c.delistVotes),
    resolved: c.resolved.length ? c.resolved[0] : null,
  }));
}
