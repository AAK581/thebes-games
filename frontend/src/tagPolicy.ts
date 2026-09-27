/**
 * tagPolicy.ts — what makes a valid, allowed tag.
 *
 * Used by the Upload UI for instant feedback. The SAME policy is enforced
 * server-side in backend/Backend.mo (begin_publish): the client check is UX,
 * the backend check is the guarantee — a determined caller can bypass the
 * browser and hit the canister directly, and a tag lands in the PUBLIC
 * on-chain catalogue, so a slur or an illegal-content tag must never be
 * storable even on an otherwise-normal game.
 *
 * KEEP THE BLOCKLIST IN SYNC with the `tagAllowed` logic in Backend.mo.
 */

export const TAG_MAX_LEN = 30;
export const TAG_MAX_COUNT = 5;

// Long, unambiguous strings no innocent tag contains — matched as SUBSTRINGS
// (after leet-folding) so "c-s-a-m" / "cs4m" / "ch1ld_p0rn" don't slip through.
const BANNED_SUBSTR = [
  "csam", "childporn", "childsex", "childabuse", "childmolest",
  "pedophile", "paedophile", "pedophilia", "jailbait",
  "lolicon", "shotacon", "bestiality", "beastiality", "zoophilia",
  "hentai", "porn", "nsfw",
];

// Short terms, or ones that could sit inside an innocent word (the
// "Scunthorpe" trap — e.g. "spic" in "spicy", "coon" in "tycoon"), matched
// only against the WHOLE folded tag so legit tags aren't caught by accident.
const BANNED_EXACT = new Set([
  "cp", "pedo", "paedo", "loli", "shota", "rape", "incest", "snuff", "molest",
  "sex", "xxx",
  "nigger", "nigga", "faggot", "fag", "chink", "kike", "spic", "tranny",
  "retard", "gook", "wetback", "coon", "dyke", "beaner", "tard",
]);

/** Collapse case, common leetspeak, and every separator so evasions fold to
    the same core string. Used ONLY for the blocklist test, never for storage. */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[@4]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/0/g, "o")
    .replace(/[$5]/g, "s")
    .replace(/7/g, "t")
    .replace(/[69]/g, "g")
    .replace(/8/g, "b")
    .replace(/[^a-z]/g, "");
}

export function isAllowedTag(raw: string): boolean {
  const f = fold(raw);
  if (!f) return true; // nothing alphabetic to judge (e.g. "2d") — allow
  if (BANNED_EXACT.has(f)) return false;
  return !BANNED_SUBSTR.some((b) => f.includes(b));
}

export type TagResult = { ok: true; tag: string } | { ok: false; reason: string };

/** Clean a raw entry to a storable tag (lowercase; letters, digits, spaces,
    hyphens; collapsed), or explain why it's rejected. */
export function cleanTag(raw: string): TagResult {
  const tag = raw
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!tag) return { ok: false, reason: "empty tag" };
  if (tag.length > TAG_MAX_LEN) return { ok: false, reason: `keep tags under ${TAG_MAX_LEN} characters` };
  // Test the ORIGINAL raw input, not the cleaned form — cleaning turns "@"/"$"
  // into spaces, which would defeat the leet-fold ("f@ggot" → "f ggot"). Fold
  // the raw so "@"→"a" is seen. Belt-and-suspenders: check the cleaned tag too.
  if (!isAllowedTag(raw) || !isAllowedTag(tag)) {
    return { ok: false, reason: "that tag isn't allowed here" };
  }
  return { ok: true, tag };
}
