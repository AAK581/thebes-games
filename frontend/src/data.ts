/**
 * data.ts — the catalogue, mocked in the shape the registry canister
 * will serve.
 *
 * Three entries are REAL games already live on the WAN gateway (their
 * `cid` points at a deployed frontend canister, verified 2026-09-21);
 * the sandboxed player embeds them at /_/raw/<cid>/index.html. The rest
 * are placeholders that exercise every catalogue state — featured,
 * plain, and quarantined — until the registry canister replaces this
 * file as the source of truth. Creator handles are placeholders, not
 * real Memphis names.
 */

export type Rating = "E" | "T" | "M";
export type GameStatus = "live" | "quarantined";

export interface Game {
  slug: string;
  title: string;
  tagline: string;
  owner: string;
  tags: string[];
  rating: Rating;
  status: GameStatus;
  description: string;
  version: string;
  sizeMB: number;
  updated: string;
  plays: number;
  favorites: number;
  /** The game's native render resolution in px; the player frames the game at
   *  exactly this so it fills the stage (no letterbox). Defaults to 816×624. */
  resW?: number;
  resH?: number;
  featured?: boolean;
  /** Frontend canister id of a live on-chain build, when one exists. */
  cid?: string;
  /**
   * Vault slug, when the game's bytes are hosted by the platform's vault
   * (uploaded via Publish) rather than living in their own canister. The
   * player serves it from /_/raw/<VAULT_CID>/g/<vaultSlug>/. Mutually
   * exclusive with `cid` in practice.
   */
  vaultSlug?: string;
  /** Creator-uploaded cover image URL (vault-served), when one exists. */
  coverUrl?: string;
  /** Creator-uploaded screenshots, in gallery order (vault-served). */
  shotUrls?: string[];
  /**
   * Backend canister id, when the game has one. This is the AUDIENCE a
   * Memphis delegated session is scoped to (docs/memphis-delegated-sessions.md,
   * §11.1): the platform mints a token only that canister can resolve. Until
   * the registry serves it, fill it per game here; a game without it can't be
   * offered in-window sign-in and falls back to the standalone link.
   */
  backendCid?: string;
  /** Open case id while quarantined. */
  caseId?: number;
}

export const GAMES: Game[] = [
  {
    slug: "basra",
    title: "Basra",
    tagline: "The Nile's own fishing card game — sweep the table, count your basras.",
    owner: "meritamun.thebes",
    tags: ["cards", "classic"],
    rating: "E",
    status: "live",
    featured: true,
    cid: "171051190939374",
    version: "1.2.0",
    sizeMB: 3.1,
    updated: "2026-09-14",
    plays: 812,
    favorites: 97,
    description:
      "The coffeehouse classic, dealt from a canister. Match cards to capture, " +
      "clear the table for a basra, and count to thirty before the deck runs dry. " +
      "Every shuffle is finalized on chain, so nobody — including the house — can " +
      "stack the deck.",
  },
  {
    slug: "revenge-of-the-retrieved",
    title: "Revenge of the Retrieved",
    tagline: "They deleted your save. Retrieve everything.",
    owner: "paneb.thebes",
    tags: ["arcade", "2d"],
    rating: "E",
    status: "live",
    cid: "99368548869172",
    version: "2.0.1",
    sizeMB: 7.8,
    updated: "2026-09-08",
    plays: 655,
    favorites: 64,
    description:
      "A fast 2D arcade chase through corrupted archives. Dash, dodge, and " +
      "recover the fragments before the garbage collector catches up. Tight " +
      "controls, one-more-run energy, and a leaderboard that lives on chain.",
  },
  {
    slug: "revenge-of-the-retrieved-3d",
    title: "Revenge of the Retrieved 3D",
    tagline: "The archives got deeper.",
    owner: "paneb.thebes",
    tags: ["arcade", "3d"],
    rating: "T",
    status: "live",
    featured: true,
    cid: "115382987180688",
    version: "0.9.4",
    sizeMB: 21.5,
    updated: "2026-09-18",
    plays: 340,
    favorites: 41,
    description:
      "The sequel trades pixels for polygons: the same chase, now through a " +
      "three-dimensional stack of ruined data-tombs. WebGL, gamepad support, " +
      "and the same on-chain leaderboard as the original.",
  },
  {
    slug: "thebes-carnage",
    title: "Thebes Carnage",
    tagline: "Hold the gate. Nothing gets past you.",
    owner: "hori.thebes",
    tags: ["action", "2d"],
    rating: "T",
    status: "live",
    version: "0.4.0",
    sizeMB: 12.2,
    updated: "2026-08-30",
    plays: 118,
    favorites: 15,
    description:
      "A single-screen action brawler set at the hundred gates of Thebes. " +
      "Waves come faster, the gate holds or it doesn't. The playable build is " +
      "being moved into the vault canister — this entry is registry-only until " +
      "it lands.",
  },
  {
    slug: "senet",
    title: "Senet",
    tagline: "The oldest board game in the world, on the newest chain.",
    owner: "sennedjem.thebes",
    tags: ["board", "classic"],
    rating: "E",
    status: "live",
    version: "1.0.2",
    sizeMB: 1.4,
    updated: "2026-09-11",
    plays: 501,
    favorites: 88,
    description:
      "Thirty squares, five thousand years. Race your pieces along the house " +
      "of rebirth against a canister opponent that plays the ancient rules " +
      "straight — throw sticks, block, and bear off before the waters take you.",
  },
  {
    slug: "duat-runner",
    title: "Duat Runner",
    tagline: "Twelve hours of night. One runner.",
    owner: "webkhet.thebes",
    tags: ["arcade", "2d"],
    rating: "T",
    status: "live",
    version: "0.7.1",
    sizeMB: 5.6,
    updated: "2026-09-05",
    plays: 264,
    favorites: 31,
    description:
      "An endless runner through the twelve gates of the underworld. Each gate " +
      "changes the rules — mirrored controls, darkness, rising water — and the " +
      "night resets at dawn, chain time.",
  },
  {
    slug: "scribes-gambit",
    title: "Scribe's Gambit",
    tagline: "Every word you write becomes a move.",
    owner: "sennedjem.thebes",
    tags: ["puzzle", "cards"],
    rating: "E",
    status: "live",
    version: "1.1.0",
    sizeMB: 2.3,
    updated: "2026-08-27",
    plays: 189,
    favorites: 27,
    description:
      "A word-building duel where spelled words are spent as tactics. Long " +
      "words hit hard but telegraph; short words jab. Daily duel seeded from " +
      "the chain, same board for everyone.",
  },
  {
    slug: "reed-boat-rally",
    title: "Reed Boat Rally",
    tagline: "Six boats, one current, no brakes.",
    owner: "nebet.thebes",
    tags: ["racing", "2d"],
    rating: "E",
    status: "live",
    version: "0.3.2",
    sizeMB: 4.9,
    updated: "2026-08-19",
    plays: 97,
    favorites: 9,
    description:
      "Top-down river racing where the current does half the steering. Draft " +
      "behind barges, cut the reeds, and don't meet the hippo. Local two-player " +
      "on one keyboard.",
  },
  {
    slug: "tomb-looter-3000",
    title: "Tomb Looter 3000",
    tagline: "Grab everything that isn't nailed down.",
    owner: "anon-4471.thebes",
    tags: ["action", "3d"],
    rating: "M",
    status: "quarantined",
    caseId: 7,
    version: "1.0.0",
    sizeMB: 38.0,
    updated: "2026-09-16",
    plays: 42,
    favorites: 2,
    description:
      "A first-person loot-em-up through procedurally stacked tombs. Currently " +
      "hidden from browse while curators review stolen-asset reports.",
  },
];

export function gameBySlug(slug: string): Game | undefined {
  return GAMES.find((g) => g.slug === slug);
}

export function allTags(): string[] {
  const t = new Set<string>();
  for (const g of GAMES) for (const tag of g.tags) t.add(tag);
  return Array.from(t).sort();
}

/* ─── transparency log ────────────────────────────────────────────────
   Mocked in the shape the registry's append-only moderation log will
   serve. Every entry a curator, panel, or threshold produces is public. */

export type LogAction =
  | "quarantine"
  | "freeze"
  | "ratify"
  | "restore"
  | "delist"
  | "strike"
  | "panel";

export interface LogEntry {
  at: string;
  action: LogAction;
  target: string;
  actor: string;
  detail: string;
  caseId?: number;
}

export const MOD_LOG: LogEntry[] = [
  {
    at: "2026-09-17",
    action: "panel",
    target: "tomb-looter-3000",
    actor: "panel #7 (3 curators, drawn by hash)",
    detail: "Case opened on stolen-asset reports; verdict due within 72h of first vote.",
    caseId: 7,
  },
  {
    at: "2026-09-16",
    action: "quarantine",
    target: "tomb-looter-3000",
    actor: "automatic (report threshold)",
    detail: "Weighted reports crossed the quarantine threshold: 6 reporters, reason `stolen`.",
    caseId: 7,
  },
  {
    at: "2026-09-09",
    action: "restore",
    target: "duat-runner",
    actor: "panel #6, 3–0",
    detail: "Harassment reports not substantiated; reporting weight of 4 accounts reduced.",
    caseId: 6,
  },
  {
    at: "2026-09-02",
    action: "ratify",
    target: "sandworm-idle",
    actor: "panel #5, 3–0",
    detail: "Emergency freeze ratified: bundle contained a wallet-drainer. Bytes purged, publisher struck.",
    caseId: 5,
  },
  {
    at: "2026-09-01",
    action: "freeze",
    target: "sandworm-idle",
    actor: "curators 2-of-9 (emergency)",
    detail: "Malware class — serving frozen immediately, bytes retained pending panel ratification.",
    caseId: 5,
  },
  {
    at: "2026-08-24",
    action: "strike",
    target: "cartouche-clicker",
    actor: "panel #4, 2–1",
    detail: "Rating misdeclaration (M content declared E). Strike 1 of 3 for publisher.",
    caseId: 4,
  },
  {
    at: "2026-08-24",
    action: "delist",
    target: "cartouche-clicker",
    actor: "panel #4, 2–1",
    detail: "Delisted until resubmitted with an honest rating.",
    caseId: 4,
  },
];
