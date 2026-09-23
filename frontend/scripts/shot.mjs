/**
 * Dev-only screenshot harness: captures the home page, the Basra game
 * page, and the Basra game RUNNING in the scaled player, so player
 * layout fixes can be verified against the real embedded game.
 *
 *   node scripts/shot.mjs [outdir]
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "shots";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_BIN ??
    `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`,
  // On this box chrome is killed the moment it opens any NON-LOOPBACK
  // socket (external killer; https and WAN URLs all die, pure-loopback
  // pages are fine). So: never let chrome touch the network — every
  // non-loopback request is intercepted below and fulfilled from Node.
  args: ["--no-sandbox", "--disable-gpu", "--single-process", "--no-zygote", "--host-resolver-rules=MAP * 127.0.0.1"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.route(
  (u) => !["127.0.0.1", "localhost"].includes(u.hostname),
  async (route) => {
    try {
      const resp = await fetch(route.request().url(), {
        method: route.request().method(),
        headers: route.request().headers(),
      });
      await route.fulfill({
        status: resp.status,
        contentType: resp.headers.get("content-type") ?? undefined,
        body: Buffer.from(await resp.arrayBuffer()),
      });
    } catch {
      await route.abort();
    }
  }
);

await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
await page.screenshot({ path: `${out}/home.png`, fullPage: true });

await page.goto("http://127.0.0.1:5173/#/game/basra", {
  waitUntil: "networkidle",
});
await page.screenshot({ path: `${out}/game-idle.png` });

await page.click(".player .stage button.play");
// The game fetches its bundle, then boots inside the sandboxed iframe.
try {
  await page.waitForSelector(".player .stage iframe", {
    timeout: 30000,
    state: "attached",
  });
} catch (e) {
  const status = await page
    .locator(".player .stage .statusline")
    .textContent()
    .catch(() => null);
  await page.screenshot({ path: `${out}/game-stuck.png` });
  console.error(`no iframe; statusline: ${status}`);
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(5000);
await page.screenshot({ path: `${out}/game-running.png` });

const frame = page.frames().find((f) => f !== page.mainFrame());
if (frame) {
  const play = frame.locator("button, a").filter({ hasText: /play/i }).first();
  if (await play.count()) {
    await play.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${out}/game-ingame.png` });
  }
}

await browser.close();
console.log(`wrote screenshots to ${out}/`);
