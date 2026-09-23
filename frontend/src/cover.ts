/**
 * cover.ts — deterministic placeholder cover art, v2: pixel game posters.
 *
 * Until creators upload real covers, every game gets a retro poster
 * generated from its slug: a banded dusk sky with dithered transitions,
 * stars, a sun or moon disc, a chunky pixel sprite (scarab, cobra, reed
 * boat, ankh, Eye of Horus, or a pyramid-shaped invader), a checkered
 * ground strip, and faint scanlines. Same slug, same poster, every
 * reload, every user — no randomness at render time.
 */

// FNV-1a, then mulberry32 — tiny, deterministic, good enough for art.
function seed(slug: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Muted retro palettes — dusk, night, dawn; warm and desaturated on
   purpose. `dark` decides whether stars are drawn. */
interface Palette {
  sky: [string, string, string];
  ground: string;
  sprite: string;
  accent: string;
  dark: boolean;
}

const PALETTES: Palette[] = [
  { sky: ["#0d1b2e", "#16365f", "#1f4e8c"], ground: "#0a1420", sprite: "#f6efdd", accent: "#d4af5a", dark: true },
  { sky: ["#1a2238", "#5c3a4e", "#a24a2e"], ground: "#14101c", sprite: "#f2e3bd", accent: "#e0b45c", dark: true },
  { sky: ["#e8d9b8", "#e3c48f", "#d9a15c"], ground: "#6b4a32", sprite: "#2b2417", accent: "#a24a2e", dark: false },
  { sky: ["#0f2426", "#173f3c", "#2e6b5e"], ground: "#0b1a18", sprite: "#efe6c8", accent: "#d4af5a", dark: true },
  { sky: ["#241417", "#5c2e26", "#8c4a2e"], ground: "#1a0f10", sprite: "#f0dfc0", accent: "#dd9f56", dark: true },
];

/* Pixel sprites. '.' empty, 'X' body color, 'o' accent color. */
const SPRITES: Record<string, string[]> = {
  scarab: [
    "..X......X..",
    ".X.X....X.X.",
    "..X.XXXX.X..",
    "...XXXXXX...",
    "..XXXXXXXX..",
    ".X.XXooXX.X.",
    "X..XXooXX..X",
    ".X.XXXXXX.X.",
    "..X.X..X.X..",
    "...X....X...",
  ],
  cobra: [
    "....XXXXX...",
    "...XXXXXXX..",
    "...Xo.XXXX..",
    "...XXXXXXX..",
    "....XXXX....",
    ".....XXX....",
    "......XXX...",
    "....XXXXX...",
    "..XXXXXXX...",
    ".XXXXXXX....",
    ".XXXXX......",
    "..XXXXXXX...",
  ],
  boat: [
    "......X.......",
    "......XX......",
    "......XoX.....",
    "......XooX....",
    "......XoX.....",
    "......XX......",
    ".X....X....X..",
    ".XX...X...XX..",
    "..XXXXXXXXX...",
    "...XXXXXXX....",
  ],
  ankh: [
    "...XXXX...",
    "..XX..XX..",
    "..X....X..",
    "..XX..XX..",
    "...XXXX...",
    "....XX....",
    ".XXXXXXXX.",
    "....XX....",
    "....XX....",
    "....XX....",
    "....XX....",
  ],
  eye: [
    "..XXXXXXXXX...",
    ".X....X....X..",
    "X..XXXXXXX..X.",
    "X.XX..o..XX.X.",
    ".X..XXXXX..X..",
    "..XXXXXXXXX...",
    ".......X......",
    "......XX.X....",
    ".....XX...X...",
    "..........X...",
  ],
  invader: [
    ".....XX.....",
    "....XXXX....",
    "...XXXXXX...",
    "..XX.XX.XX..",
    ".XXXXXXXXXX.",
    ".X.XXooXX.X.",
    ".X.X....X.X.",
    "...XX..XX...",
    "..X......X..",
    ".X........X.",
  ],
};

const SPRITE_NAMES = Object.keys(SPRITES);

const W = 315;
const H = 250;
const GROUND_Y = 200;
const DITHER = 8;

function rect(x: number, y: number, w: number, h: number, fill: string): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
}

/** One row of 8px checker squares — the dithered seam between two bands. */
function ditherRow(y: number, a: string, b: string): string {
  let out = "";
  for (let i = 0; i < W / DITHER; i++) {
    out += rect(i * DITHER, y, DITHER, DITHER, i % 2 === 0 ? a : b);
  }
  return out;
}

function drawSprite(
  bitmap: string[],
  cell: number,
  ox: number,
  oy: number,
  body: string,
  accent: string,
  flip: boolean
): string {
  let out = "";
  const cols = bitmap[0].length;
  for (let r = 0; r < bitmap.length; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = bitmap[r][flip ? cols - 1 - c : c];
      if (ch === ".") continue;
      out += rect(ox + c * cell, oy + r * cell, cell, cell, ch === "o" ? accent : body);
    }
  }
  return out;
}

export function coverFor(slug: string): string {
  const rnd = seed(slug);
  const pal = PALETTES[Math.floor(rnd() * PALETTES.length)];
  const bitmap = SPRITES[SPRITE_NAMES[Math.floor(rnd() * SPRITE_NAMES.length)]];

  let out = "";

  // Sky: three bands with dithered seams.
  const b1 = 70 + Math.floor(rnd() * 30);
  const b2 = b1 + 50 + Math.floor(rnd() * 30);
  out += rect(0, 0, W, b1, pal.sky[0]);
  out += ditherRow(b1 - DITHER, pal.sky[0], pal.sky[1]);
  out += rect(0, b1, W, b2 - b1, pal.sky[1]);
  out += ditherRow(b2 - DITHER, pal.sky[1], pal.sky[2]);
  out += rect(0, b2, W, GROUND_Y - b2, pal.sky[2]);

  // Stars on dark skies.
  if (pal.dark) {
    const n = 10 + Math.floor(rnd() * 8);
    for (let i = 0; i < n; i++) {
      const sx = Math.floor(rnd() * (W / 3)) * 3;
      const sy = Math.floor((rnd() * (GROUND_Y - 60)) / 3) * 3;
      out += rect(sx, sy, 2, 2, i % 3 === 0 ? pal.accent : pal.sprite);
    }
  }

  // Sun or moon disc.
  const cx = 60 + Math.floor(rnd() * (W - 120));
  const cy = 45 + Math.floor(rnd() * 45);
  const r = 24 + Math.floor(rnd() * 14);
  out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${pal.accent}"/>`;

  // Ground with a dithered horizon.
  out += ditherRow(GROUND_Y - DITHER, pal.sky[2], pal.ground);
  out += rect(0, GROUND_Y, W, H - GROUND_Y, pal.ground);

  // The sprite, standing on the ground line.
  const cell = 13;
  const cols = bitmap[0].length;
  const ox = Math.floor((W - cols * cell) / 2);
  const oy = GROUND_Y + 10 - bitmap.length * cell;
  out += drawSprite(bitmap, cell, ox, oy, pal.sprite, pal.accent, rnd() < 0.5);

  // Faint scanlines over everything.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">` +
    `<defs><pattern id="sl" width="4" height="4" patternUnits="userSpaceOnUse">` +
    `<rect width="4" height="1" fill="#000000" opacity="0.08"/></pattern></defs>` +
    out +
    `<rect width="${W}" height="${H}" fill="url(#sl)"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** One repeat of the pixel-glyph frieze — the sprites marching in a
    band, like a temple wall relief. Drawn in solid black because it is
    meant to be used as a CSS mask (the stylesheet supplies the color, so
    the same asset works in both themes). */
export function friezeURI(): string {
  const order: (keyof typeof SPRITES)[] = [
    "eye",
    "ankh",
    "scarab",
    "boat",
    "invader",
    "cobra",
  ];
  const cell = 3;
  const gap = 30;
  const h = 40;
  let x = gap / 2;
  let out = "";
  for (const name of order) {
    const bitmap = SPRITES[name];
    const oy = Math.floor((h - bitmap.length * cell) / 2);
    out += drawSprite(bitmap, cell, x, oy, "#000", "#000", false);
    x += bitmap[0].length * cell + gap;
  }
  const w = x - gap / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges">` +
    out +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** A lone sprite as a data URI — for empty states and friends.
    (Unicode hieroglyphs render as tofu on common platforms, so decorative
    glyphs are drawn, not typed.) */
export function spriteURI(name: keyof typeof SPRITES, fill = "#8a8f98"): string {
  const bitmap = SPRITES[name];
  const cols = bitmap[0].length;
  const cell = 6;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols * cell} ${bitmap.length * cell}" shape-rendering="crispEdges">` +
    drawSprite(bitmap, cell, 0, 0, fill, fill, false) +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
