/**
 * coverPrep.ts — turn a user-picked image into a cover the vault will accept.
 *
 * Shared by the publish flow and the My Games listing editor, so a cover
 * uploaded either way lands under the same limits.
 *
 * The upload itself isn't size-bound (registry.setCover chunks it), but a cover
 * is SERVED inline in one http_request response, so it has to fit the backend's
 * ~1.9 MB single-response cap. We downscale on the client rather than rejecting:
 * a shelf tile never shows more than a few hundred px, so a 6000px screenshot
 * would spend the whole budget on pixels nobody sees.
 */

export const COVER_MAX_DIM = 1600; // longest side, px
export const COVER_MAX_BYTES = 1_500_000; // margin under the backend's 1.9 MB serve cap

export interface PreparedCover {
  bytes: Uint8Array;
  type: string;
  w: number;
  h: number;
}

/**
 * Decode, clamp to COVER_MAX_DIM, and keep under COVER_MAX_BYTES. An image that
 * already fits is passed through byte-for-byte — never re-encoded, so art that
 * is already in spec doesn't lose a generation of quality for nothing.
 */
export async function prepareCover(file: File): Promise<PreparedCover> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("that file isn't a readable image"));
      i.src = url;
    });
    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    const raw = new Uint8Array(await file.arrayBuffer());
    const scale = Math.min(1, COVER_MAX_DIM / Math.max(w0, h0));
    if (scale === 1 && raw.length <= COVER_MAX_BYTES) {
      return { bytes: raw, type: file.type || "image/png", w: w0, h: h0 };
    }
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("couldn't process that image in this browser");
    ctx.drawImage(img, 0, 0, w, h);
    // WebP is the smallest broadly-supported encode; step quality down until it
    // fits the cap.
    let blob: Blob | null = null;
    for (const q of [0.9, 0.82, 0.72, 0.6, 0.5]) {
      blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", q));
      if (blob && blob.size <= COVER_MAX_BYTES) break;
    }
    if (!blob || blob.size > COVER_MAX_BYTES) {
      throw new Error("couldn't shrink that cover enough — try a smaller image");
    }
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      type: blob.type || "image/webp",
      w,
      h,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
