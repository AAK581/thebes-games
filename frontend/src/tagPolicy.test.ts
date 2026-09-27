/**
 * tagPolicy.test.ts — the blocklist's two failure modes, pinned:
 * an evasion slipping THROUGH (leetspeak, separators), and an innocent tag
 * getting CAUGHT (the Scunthorpe trap). Backend.mo enforces the same rules
 * on chain; these tests are the spec both sides are kept in sync against.
 */
import { describe, it, expect } from "vitest";
import { cleanTag, isAllowedTag, TAG_MAX_LEN, TAG_MAX_COUNT } from "./tagPolicy";

const ok = (raw: string) => {
  const r = cleanTag(raw);
  expect(r.ok, `expected "${raw}" to be allowed`).toBe(true);
  return r.ok ? r.tag : "";
};
const blocked = (raw: string) => {
  const r = cleanTag(raw);
  expect(r.ok, `expected "${raw}" to be blocked`).toBe(false);
};

describe("cleanTag — normal tags pass and normalize", () => {
  it("keeps the suggested vocabulary intact", () => {
    for (const t of ["action", "rpg", "pixel-art", "co-op", "2d", "horror", "cards"])
      expect(ok(t)).toBe(t);
  });
  it("lowercases, collapses whitespace, strips stray punctuation", () => {
    expect(ok("  Pixel   Art ")).toBe("pixel art");
    expect(ok("Rogue-like!")).toBe("rogue-like");
    expect(ok("local multiplayer")).toBe("local multiplayer");
  });
  it("rejects empty and over-length entries", () => {
    blocked("");
    blocked("!!!");
    blocked("a".repeat(TAG_MAX_LEN + 1));
    expect(ok("a".repeat(TAG_MAX_LEN))).toBe("a".repeat(TAG_MAX_LEN));
  });
});

describe("blocklist — evasions fold onto the banned core", () => {
  it("blocks slurs, plainly and leet-folded", () => {
    for (const t of ["nigger", "n1gger", "N199A", "f@ggot", "fag", "sp1c", "tranny"])
      blocked(t);
  });
  it("blocks illegal-content terms through separators and leetspeak", () => {
    for (const t of [
      "csam", "c-s-a-m", "cs4m",
      "child porn", "ch1ld p0rn",
      "lolicon", "jailbait", "bestiality",
      "porn", "nsfw", "hentai", "sex", "xxx", "rape",
    ])
      blocked(t);
  });
  it("blocks a banned substring inside a longer tag", () => {
    blocked("best hentai games");
    blocked("jailbait4ever");
  });
});

describe("blocklist — the Scunthorpe trap stays open", () => {
  it("allows innocent words containing short banned terms", () => {
    // "spic" in spicy, "coon" in tycoon, "rape" in grape, "sex" in sussex,
    // "tard" in mustard — all exact-match-only terms, so the words pass.
    for (const t of ["spicy", "tycoon", "grape", "sussex", "mustard", "classic"])
      expect(ok(t)).toBe(t);
  });
});

describe("isAllowedTag — raw-vs-cleaned belt and suspenders", () => {
  it("judges the RAW string so cleaning can't defeat the fold", () => {
    // cleanTag turns "@" into a space ("f ggot"), which alone would slip the
    // fold — the raw-input check is what catches it.
    expect(isAllowedTag("f@ggot")).toBe(false);
    blocked("f@ggot");
  });
  it("passes digit-only tags (nothing alphabetic to judge)", () => {
    expect(isAllowedTag("2d")).toBe(true);
  });
});

describe("constants stay in sync with Backend.mo", () => {
  it("TAG_MAX_LEN=30, TAG_MAX_COUNT=5 (backend mirrors these literals)", () => {
    expect(TAG_MAX_LEN).toBe(30);
    expect(TAG_MAX_COUNT).toBe(5);
  });
});
