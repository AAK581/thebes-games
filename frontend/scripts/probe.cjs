/* Live integration probe against the deployed registry+vault (no browser).
   Encodes/decodes Candid exactly like registry.ts and hits the gateway /api. */
const { IDL } = require("@dfinity/candid");

const GATEWAY = "https://memphis.mercaturaforum.com";
const CID = 24874376952694;

const Rating = IDL.Variant({ E: IDL.Null, T: IDL.Null, M: IDL.Null });
const Source = IDL.Variant({ vault: IDL.Null, canister: IDL.Text });
const Status = IDL.Variant({ live: IDL.Null, quarantined: IDL.Record({ caseId: IDL.Nat }) });
const Blob = IDL.Vec(IDL.Nat8);
const GameMeta = IDL.Record({ title: IDL.Text, tagline: IDL.Text, description: IDL.Text, tags: IDL.Vec(IDL.Text), rating: Rating, resW: IDL.Opt(IDL.Nat), resH: IDL.Opt(IDL.Nat) });
const GameView = IDL.Record({ slug: IDL.Text, title: IDL.Text, tagline: IDL.Text, description: IDL.Text, tags: IDL.Vec(IDL.Text), rating: Rating, owner: IDL.Text, source: Source, sizeBytes: IDL.Nat, updatedAtNs: IDL.Nat64, status: Status, plays: IDL.Nat, favorites: IDL.Nat, cover: IDL.Bool, shots: IDL.Nat, resW: IDL.Nat, resH: IDL.Nat });
const ResText = IDL.Variant({ ok: IDL.Text, err: IDL.Text });

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));
const enc = (t, v) => hex(new Uint8Array(IDL.encode(t, v)));
const rnd = () => hex(require("crypto").randomBytes(8));

async function query(method, argHex) {
  const r = await fetch(`${GATEWAY}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canister_id: CID, method, arg: argHex, sender: rnd() }),
  });
  const j = await r.json();
  if (j.status !== "success") throw new Error(`query ${method}: ${j.error || JSON.stringify(j)}`);
  return unhex(j.reply || "");
}

async function call(method, argHex) {
  const sender = rnd();
  const nj = await (await fetch(`${GATEWAY}/api/next_nonce?sender=${sender}`)).json();
  const cr = await fetch(`${GATEWAY}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canister_id: CID, method, arg: argHex, sender, nonce: nj.next_nonce }),
  });
  const cj = await cr.json();
  if (!cj.queued || !cj.message_hash) throw new Error(`call ${method}: ${cj.error || JSON.stringify(cj)}`);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    const rj = await (await fetch(`${GATEWAY}/api/receipt?hash=${cj.message_hash}`)).json();
    if (rj.found) {
      if (rj.status === "success") return unhex(rj.reply || "");
      throw new Error(`call ${method} failed: ${rj.error}`);
    }
  }
  throw new Error(`call ${method}: receipt timeout`);
}

(async () => {
  console.log("── 0. build_tag() — which build is live? ──");
  try {
    const [tag] = IDL.decode([IDL.Text], await query("build_tag", enc([], [])));
    console.log(`   ${tag}`);
  } catch (e) {
    // Builds before 2026-09-27 don't have the query.
    console.log(`   (no build_tag — a pre-2026-09-27 build) ${e.message.slice(0, 60)}`);
  }

  console.log("\n── 1. catalogue() — is the registry live + seeded? ──");
  const [views] = IDL.decode([IDL.Vec(GameView)], await query("catalogue", enc([], [])));
  console.log(`   ${views.length} games:`);
  for (const v of views) {
    const src = "vault" in v.source ? "vault" : `canister ${v.source.canister}`;
    console.log(`   • ${v.slug}  "${v.title}"  [${Object.keys(v.rating)[0]}]  ${src}  ${v.resW}×${v.resH}`);
  }

  console.log("\n── 2. game('basra') — single lookup ──");
  const [opt] = IDL.decode([IDL.Opt(GameView)], await query("game", enc([IDL.Text], ["basra"])));
  console.log(opt.length ? `   found: ${opt[0].title} (owner ${opt[0].owner})` : "   NOT FOUND");

  console.log("\n── 3. begin_publish with a BOGUS token — auth gating? ──");
  const bogus = new Uint8Array(32); // all zeros — not a real Memphis session
  const meta = { title: "Probe", tagline: "t", description: "d", tags: ["test"], rating: { E: null }, resW: [], resH: [] };
  const [res] = IDL.decode([ResText], await call("begin_publish", enc([Blob, GameMeta], [bogus, meta])));
  console.log("err" in res ? `   correctly rejected: "${res.err}"` : `   UNEXPECTED ok: ${res.ok}`);

  console.log("\n── 4. update_game with a BOGUS token — deployed + gated? ──");
  // Also a deploy-lag detector: "method not found" here means the deployed
  // backend predates update_game — redeploy (thebes-deploy … --upgrade).
  try {
    const ResUnit = IDL.Variant({ ok: IDL.Null, err: IDL.Text });
    const [ur] = IDL.decode(
      [ResUnit],
      await call("update_game", enc([Blob, IDL.Text, GameMeta], [bogus, "probe-no-such-game", meta]))
    );
    console.log("err" in ur ? `   correctly rejected: "${ur.err}"` : `   UNEXPECTED ok`);
  } catch (e) {
    if (/not found/i.test(e.message)) {
      console.log("   ✗ update_game MISSING on the deployed canister — the deploy is behind source");
    } else {
      throw e;
    }
  }

  console.log("\n── 5. adoptable_games() — the unowned house listings ──");
  try {
    const [av] = IDL.decode([IDL.Vec(GameView)], await query("adoptable_games", enc([], [])));
    if (!av.length) console.log("   none — every listing has an owner");
    for (const v of av) console.log(`   • ${v.slug}  "${v.title}"  byline "${v.owner}"  cover ${v.cover}`);
  } catch (e) {
    console.log(`   ✗ adoptable_games missing — deploy is behind source (${e.message.slice(0, 50)})`);
  }

  console.log("\n── 6. adopt_game with a BOGUS token — owner-gated? ──");
  try {
    const ResUnit = IDL.Variant({ ok: IDL.Null, err: IDL.Text });
    const [ar] = IDL.decode([ResUnit], await call("adopt_game", enc([Blob, IDL.Text], [bogus, "basra"])));
    console.log("err" in ar ? `   correctly rejected: "${ar.err}"` : "   UNEXPECTED ok — ADOPT IS UNGATED");
  } catch (e) {
    console.log(`   ✗ adopt_game missing — deploy is behind source (${e.message.slice(0, 50)})`);
  }

  console.log("\n── 7. screenshots — deployed + owner-gated? ──");
  try {
    const ResNat = IDL.Variant({ ok: IDL.Nat, err: IDL.Text });
    const [sr] = IDL.decode(
      [ResNat],
      await call("shot_chunk", enc([Blob, IDL.Text, Blob], [bogus, "basra", new Uint8Array(8)]))
    );
    console.log("err" in sr ? `   correctly rejected: "${sr.err}"` : "   UNEXPECTED ok — SHOTS ARE UNGATED");
    const [vs] = IDL.decode([IDL.Vec(GameView)], await query("catalogue", enc([], [])));
    console.log("   gallery counts: " + vs.map((v) => `${v.slug}=${v.shots}`).join("  "));
  } catch (e) {
    console.log(`   ✗ screenshots missing — deploy is behind source (${e.message.slice(0, 50)})`);
  }

  console.log("\n✓ probe complete");
})().catch((e) => { console.error("PROBE ERROR:", e.message); process.exit(1); });
