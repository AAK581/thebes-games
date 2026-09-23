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
 *   unpublish     : (blob, text)                  -> variant { ok;      err:text }
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
});
const ResText = IDL.Variant({ ok: IDL.Text, err: IDL.Text });
const ResNat = IDL.Variant({ ok: IDL.Nat, err: IDL.Text });
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
}

// ─── publish (auth-gated, chunked) ───────────────────────────────────────

export async function beginPublish(
  tokenHex: string,
  m: MetaInput
): Promise<string> {
  const args = enc(
    [BlobT, GameMetaT],
    [
      fromHex(tokenHex),
      {
        title: m.title,
        tagline: m.tagline,
        description: m.description,
        tags: m.tags,
        rating: ratingVariant(m.rating),
      },
    ]
  );
  const [res] = dec([ResText], await callRaw("begin_publish", args));
  return unwrap<string>(res, "begin_publish");
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
    plays: 0,
    favorites: 0,
    cid: canisterCid,
    vaultSlug,
  };
}
