/**
 * The bug this pins: a description typed with line breaks rendered as one wall
 * of text, because HTML collapses newlines. The editor showed them (a textarea
 * preserves them) while the game page did not.
 */
import { describe, it, expect } from "vitest";
import { paragraphsOf } from "./pages/Game";

describe("paragraphsOf", () => {
  it("splits on blank lines", () => {
    expect(paragraphsOf("One.\n\nTwo.\n\nThree.")).toEqual(["One.", "Two.", "Three."]);
  });

  it("keeps single newlines INSIDE a paragraph (css pre-line renders them)", () => {
    expect(paragraphsOf("Controls:\nWASD to move\nSpace to jump")).toEqual([
      "Controls:\nWASD to move\nSpace to jump",
    ]);
  });

  it("treats a whitespace-only line as a paragraph break", () => {
    // A textarea readily produces "\n   \n" — it must not become one paragraph.
    expect(paragraphsOf("First.\n   \nSecond.")).toEqual(["First.", "Second."]);
  });

  it("tolerates \\r\\n (pasted from Windows)", () => {
    expect(paragraphsOf("First.\r\n\r\nSecond.")).toEqual(["First.", "Second."]);
  });

  it("drops empty and whitespace-only input rather than rendering blank <p>s", () => {
    expect(paragraphsOf("")).toEqual([]);
    expect(paragraphsOf("\n\n   \n")).toEqual([]);
    expect(paragraphsOf("Body.\n\n\n\n")).toEqual(["Body."]);
  });

  it("leaves a plain single-line description alone", () => {
    expect(paragraphsOf("A short one.")).toEqual(["A short one."]);
  });
});
