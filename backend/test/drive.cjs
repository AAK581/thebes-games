/* drive.cjs — end-to-end moderation battery against the LOCAL chain.
   Mirrors probe.cjs's gateway protocol; every step is a bounded assertion.
   Cast (token text == display tag; MockMemphis makes anchor = token bytes):
     mallory  — publishes the "bad" game
     admin    — claims platform ownership (first curator)
     cora     — appointed second curator
     r1..r5   — reporters
     paula    — publishes an innocent game (restore path)
     badguy   — invalid session (mock rejects tokens starting with "bad")
*/
const { IDL } = require("@dfinity/candid");

const GATEWAY = "http://127.0.0.1:8280";
const CID = 24874376952694;

const Rating = IDL.Variant({ E: IDL.Null, T: IDL.Null, M: IDL.Null });
const Source = IDL.Variant({ vault: IDL.Null, canister: IDL.Text });
const Status = IDL.Variant({ live: IDL.Null, quarantined: IDL.Record({ caseId: IDL.Nat }) });
const Blob = IDL.Vec(IDL.Nat8);
const GameMeta = IDL.Record({ title: IDL.Text, tagline: IDL.Text, description: IDL.Text, tags: IDL.Vec(IDL.Text), rating: Rating, resW: IDL.Opt(IDL.Nat), resH: IDL.Opt(IDL.Nat) });
const GameView = IDL.Record({ slug: IDL.Text, title: IDL.Text, tagline: IDL.Text, description: IDL.Text, tags: IDL.Vec(IDL.Text), rating: Rating, owner: IDL.Text, source: Source, sizeBytes: IDL.Nat, updatedAtNs: IDL.Nat64, status: Status, plays: IDL.Nat, favorites: IDL.Nat, cover: IDL.Bool, shots: IDL.Nat, resW: IDL.Nat, resH: IDL.Nat });
const LogEntry = IDL.Record({ atNs: IDL.Nat64, action: IDL.Text, target: IDL.Text, who: IDL.Text, detail: IDL.Text, caseId: IDL.Nat });
const CaseView = IDL.Record({ id: IDL.Nat, slug: IDL.Text, kind: IDL.Text, openedAtNs: IDL.Nat64, restoreVotes: IDL.Nat, delistVotes: IDL.Nat, resolved: IDL.Opt(IDL.Text) });
const ResText = IDL.Variant({ ok: IDL.Text, err: IDL.Text });
const ResNat = IDL.Variant({ ok: IDL.Nat, err: IDL.Text });
const ResUnit = IDL.Variant({ ok: IDL.Null, err: IDL.Text });

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));
const enc = (t, v) => hex(new Uint8Array(IDL.encode(t, v)));
const rnd = () => hex(require("crypto").randomBytes(8));
const tok = (name) => Array.from(Buffer.from(name, "utf8")); // token blob as nat8[]

async function query(method, argHex) {
  const r = await fetch(`${GATEWAY}/api/query`, {
    method: "POST", headers: { "content-type": "application/json" },
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
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ canister_id: CID, method, arg: argHex, sender, nonce: nj.next_nonce }),
  });
  const cj = await cr.json();
  if (!cj.queued || !cj.message_hash) throw new Error(`call ${method}: ${cj.error || JSON.stringify(cj)}`);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r2) => setTimeout(r2, 500));
    const rj = await (await fetch(`${GATEWAY}/api/receipt?hash=${cj.message_hash}`)).json();
    if (rj.found) {
      if (rj.status === "success") return unhex(rj.reply || "");
      throw new Error(`call ${method} failed: ${rj.error}`);
    }
  }
  throw new Error(`call ${method}: receipt timeout`);
}

// Decoded helpers
const dec = (types, bytes) => IDL.decode(types, bytes);
async function resTextCall(method, types, vals) {
  const [v] = dec([ResText], await call(method, enc(types, vals)));
  return v;
}
async function gameOf(slug) {
  const [v] = dec([IDL.Opt(GameView)], await query("game", enc([IDL.Text], [slug])));
  return v.length ? v[0] : null;
}
async function modLog() {
  const [v] = dec([IDL.Vec(LogEntry)], await query("mod_log", enc([], [])));
  return v;
}
async function openCases() {
  const [v] = dec([IDL.Vec(CaseView)], await query("open_cases", enc([], [])));
  return v;
}
async function serveStatus(slug, file) {
  const r = await fetch(`${GATEWAY}/_/raw/${CID}/g/${slug}/${file}`);
  const body = await r.text();
  return { code: r.status, body };
}

const meta = (title) => ({ title, tagline: "a test", description: "test game", tags: ["puzzle"], rating: { E: null }, resW: [], resH: [] });

let pass = 0, fail = 0, findings = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`); }
}
function finding(label, text) { findings.push(`${label}: ${text}`); console.log(`  ▲ FINDING ${label} — ${text}`); }

async function publish(who, title, marker) {
  const r1 = await resTextCall("begin_publish", [Blob, GameMeta], [tok(who), meta(title)]);
  if ("err" in r1) return r1;
  const slug = r1.ok;
  const html = `<html><body>${marker}</body></html>`;
  const [r2] = dec([ResNat], await call("put_chunk", enc([Blob, IDL.Text, IDL.Text, Blob], [tok(who), slug, "index.html", Array.from(Buffer.from(html))])));
  if ("err" in r2) return { err: r2.err };
  const r3 = await resTextCall("finish_publish", [Blob, IDL.Text], [tok(who), slug]);
  if ("err" in r3) return r3;
  return { ok: slug };
}
async function report(who, slug, reason) {
  return resTextCall("report", [Blob, IDL.Text, IDL.Text], [tok(who), slug, reason]);
}
async function vote(who, caseId, restore) {
  return resTextCall("vote", [Blob, IDL.Nat, IDL.Bool], [tok(who), caseId, restore]);
}

(async () => {
  console.log("═══ A. a user publishes something wrong ═══");
  const pub = await publish("mallory", "Totally Normal Game", "TOTALLY-NOT-MALWARE-MARKER");
  check("A1 publish ok", "ok" in pub, JSON.stringify(pub));
  const slug = pub.ok;
  check("A2 slug", slug === "totally-normal-game", slug);
  let g = await gameOf(slug);
  check("A3 live + owned by mallory", g && "live" in g.status && g.owner === "mallory");
  let s = await serveStatus(slug, "index.html");
  check("A4 serves while live (200 + marker)", s.code === 200 && s.body.includes("TOTALLY-NOT-MALWARE-MARKER"), `got ${s.code}`);

  console.log("═══ B. governance bootstrap (TOFU + curators) ═══");
  const [b1] = dec([ResUnit], await call("claim_owner", enc([Blob], [tok("admin")])));
  check("B1 admin claims platform ownership", "ok" in b1, JSON.stringify(b1));
  const [b2] = dec([ResUnit], await call("claim_owner", enc([Blob], [tok("mallory")])));
  check("B2 second claim rejected", "err" in b2, JSON.stringify(b2));
  const [b3] = dec([ResUnit], await call("add_curator", enc([Blob, Blob], [tok("admin"), tok("cora")])));
  check("B3 admin appoints curator cora", "ok" in b3, JSON.stringify(b3));
  const [b4] = dec([IDL.Bool], await call("am_i_curator", enc([Blob], [tok("cora")])));
  check("B4 cora is a curator", b4 === true);
  const [b5] = dec([IDL.Bool], await call("am_i_curator", enc([Blob], [tok("mallory")])));
  check("B5 mallory is not", b5 === false);

  console.log("═══ C. three distinct reports → auto-quarantine ═══");
  const c1 = await report("r1", slug, "this is malware");
  check("C1 r1 reports", "ok" in c1);
  const c2 = await report("r1", slug, "again");
  check("C2 duplicate reporter rejected", "err" in c2 && c2.err.includes("already reported"), JSON.stringify(c2));
  const c3 = await report("r2", slug, "malware");
  check("C3 r2 reports", "ok" in c3);
  g = await gameOf(slug);
  check("C4 still live at 2 reports", g && "live" in g.status);
  const c5 = await report("r3", slug, "malware");
  check("C5 r3 reports", "ok" in c5);
  g = await gameOf(slug);
  check("C6 quarantined at 3 (case 1)", g && "quarantined" in g.status && Number(g.status.quarantined.caseId) === 1, JSON.stringify(g && g.status, (k,v)=>typeof v==="bigint"?Number(v):v));
  const oc = await openCases();
  check("C7 one open reports-case", oc.length === 1 && oc[0].kind === "reports" && oc[0].resolved.length === 0);
  const badRep = await report("badguy", slug, "x");
  check("C8 invalid session cannot report", "err" in badRep && badRep.err.includes("not signed in"), JSON.stringify(badRep));

  s = await serveStatus(slug, "index.html");
  check("C9 quarantined game is NOT served (451)", s.code === 451 && s.body.includes("under review"), `got ${s.code}: ${s.body.slice(0, 60)}`);
  s = await serveStatus(slug, "__cover");
  check("C10 quarantined cover not served either", s.code === 451, `got ${s.code}`);

  console.log("═══ D. curator panel: delist + strike ═══");
  const d1 = await vote("mallory", 1, false);
  check("D1 non-curator cannot vote", "err" in d1 && d1.err.includes("curators only"));
  const d2 = await vote("admin", 1, false);
  check("D2 admin votes delist", "ok" in d2);
  g = await gameOf(slug);
  check("D3 1 vote: unresolved, still quarantined", g && "quarantined" in g.status);
  const d4 = await vote("cora", 1, false);
  check("D4 cora votes delist → majority", "ok" in d4);
  g = await gameOf(slug);
  check("D5 game is gone from the registry", g === null);
  s = await serveStatus(slug, "index.html");
  check("D6 delisted game no longer served", s.code === 404, `got ${s.code}`);
  const d7 = await vote("admin", 1, true);
  check("D7 resolved case rejects votes", "err" in d7 && d7.err.includes("resolved"));

  console.log("═══ E. repeat offender: strikes accumulate → suspension ═══");
  const pub2 = await publish("mallory", "Totally Normal Game", "ROUND-2");
  check("E1 republish after 1 strike ok (same slug back)", "ok" in pub2 && pub2.ok === slug, JSON.stringify(pub2));
  const e2 = await report("r1", slug, "it is back");
  check("E2 reports died with the delisted listing (r1 can report the new one)", "ok" in e2, JSON.stringify(e2));
  const e3 = await report("r4", slug, "still malware");
  check("E3 r4 reports", "ok" in e3);
  g = await gameOf(slug);
  check("E4 two fresh reports do NOT re-quarantine (no stale set)", g && "live" in g.status, JSON.stringify(g && g.status, (k,v)=>typeof v==="bigint"?Number(v):v));
  await report("r5", slug, "malware");
  g = await gameOf(slug);
  check("E5 third fresh report quarantines (case 2)", g && "quarantined" in g.status && Number(g.status.quarantined.caseId) === 2);
  await vote("admin", 2, false); await vote("cora", 2, false);
  check("E6 delisted again (strike 2)", (await gameOf(slug)) === null);
  const pub3 = await publish("mallory", "Totally Normal Game", "ROUND-3");
  check("E7 republish after 2 strikes ok", "ok" in pub3);
  await report("r1", slug, "round 3"); await report("r2", slug, "round 3"); await report("r3", slug, "round 3");
  g = await gameOf(slug);
  check("E8 quarantined (case 3)", g && "quarantined" in g.status && Number(g.status.quarantined.caseId) === 3);
  await vote("admin", 3, false); await vote("cora", 3, false);
  check("E9 delisted (strike 3)", (await gameOf(slug)) === null);
  const pub4 = await resTextCall("begin_publish", [Blob, GameMeta], [tok("mallory"), meta("Another One")]);
  check("E10 3 strikes → publishing suspended", "err" in pub4 && pub4.err.includes("suspended"), JSON.stringify(pub4));

  console.log("═══ F. the innocent publisher: restore + emergency brake ═══");
  const pubP = await publish("paula", "Innocent Puzzle", "WHOLESOME");
  check("F1 paula publishes", "ok" in pubP);
  const slug2 = pubP.ok;
  await report("r1", slug2, "i don't like it");
  await report("r2", slug2, "brigade");
  await report("r3", slug2, "brigade");
  g = await gameOf(slug2);
  check("F2 brigaded into quarantine (case 4)", g && "quarantined" in g.status && Number(g.status.quarantined.caseId) === 4);
  await vote("admin", 4, true);
  const f3 = await vote("cora", 4, true);
  check("F3 restore votes accepted", "ok" in f3);
  g = await gameOf(slug2);
  check("F4 restored to live", g && "live" in g.status);
  const f5 = await report("r1", slug2, "second try");
  check("F5 reports were cleared on restore (r1 can report again)", "ok" in f5, JSON.stringify(f5));
  g = await gameOf(slug2);
  check("F6 1 report after restore: still live", g && "live" in g.status);
  const f7 = await resTextCall("emergency_freeze", [Blob, IDL.Text, IDL.Text], [tok("r1"), slug2, "i am not a curator"]);
  check("F7 non-curator cannot emergency-freeze", "err" in f7 && f7.err.includes("curators only"));
  const [f8] = dec([IDL.Variant({ ok: IDL.Nat, err: IDL.Text })], await call("emergency_freeze", enc([Blob, IDL.Text, IDL.Text], [tok("cora"), slug2, "actually malware in level 2"])));
  check("F8 curator emergency-freezes instantly (case 5)", "ok" in f8 && Number(f8.ok) === 5, JSON.stringify(f8, (k,v)=>typeof v==="bigint"?Number(v):v));
  g = await gameOf(slug2);
  check("F9 frozen", g && "quarantined" in g.status);
  s = await serveStatus(slug2, "index.html");
  check("F10 the brake actually stops serving (451)", s.code === 451, `got ${s.code}`);
  const [f10b] = dec([IDL.Variant({ ok: IDL.Nat, err: IDL.Text })], await call("emergency_freeze", enc([Blob, IDL.Text, IDL.Text], [tok("admin"), slug2, "double freeze"])));
  check("F10b no second case on an already-frozen game", "err" in f10b && f10b.err.includes("already quarantined"), JSON.stringify(f10b, (k,v)=>typeof v==="bigint"?Number(v):v));
  await vote("admin", 5, true); await vote("cora", 5, true);
  g = await gameOf(slug2);
  check("F11 ratified back to live", g && "live" in g.status);
  s = await serveStatus(slug2, "index.html");
  check("F12 restored game serves again (200)", s.code === 200 && s.body.includes("WHOLESOME"), `got ${s.code}`);

  console.log("═══ G. the public transparency log ═══");
  const log = await modLog();
  const count = (a) => log.filter((e) => e.action === a).length;
  check("G1 owner claim logged", count("owner") === 1);
  check("G2 curator appointment logged", count("curator") === 1);
  check("G3 reports logged", count("report") >= 8, `${count("report")}`);
  check("G4 quarantines logged", count("quarantine") === 4, `${count("quarantine")}`);
  check("G5 emergency freeze logged", count("emergency-freeze") === 1);
  check("G6 votes logged", count("vote") >= 10, `${count("vote")}`);
  check("G7 delists logged", count("delist") === 3);
  check("G8 strikes logged", count("strike") === 3);
  check("G9 restores logged", count("restore") === 2);
  console.log("\n  ── full log (oldest first) ──");
  for (const e of [...log].reverse()) console.log(`  ${e.action.padEnd(16)} ${e.target.padEnd(22)} ${e.who.padEnd(10)} ${e.detail}  ${Number(e.caseId) ? "case " + e.caseId : ""}`);

  console.log("═══ H. usernames: the public gaming handle ═══");
  const UsernameCheck = IDL.Variant({ free: IDL.Null, taken: IDL.Null, invalid: IDL.Text });
  const ResUnitV = ResUnit;
  const setU = async (who, u) => {
    const [v] = dec([ResUnitV], await call("set_username", enc([Blob, IDL.Text], [tok(who), u])));
    return v;
  };
  const checkU = async (u) => {
    const [v] = dec([UsernameCheck], await query("username_check", enc([IDL.Text], [u])));
    return v;
  };
  const myU = async (who) => {
    const [v] = dec([IDL.Opt(IDL.Text)], await call("my_username", enc([Blob], [tok(who)])));
    return v.length ? v[0] : null;
  };

  check("H1 fresh handle reads free", "free" in (await checkU("Paula Power")));
  const h2 = await setU("paula", "Paula Power");
  check("H2 paula picks Paula Power", "ok" in h2, JSON.stringify(h2));
  check("H3 my_username roundtrips", (await myU("paula")) === "Paula Power");
  const h4 = await setU("r1", "paula power");
  check("H4 case-insensitive duplicate rejected", "err" in h4 && h4.err.includes("taken"), JSON.stringify(h4));
  check("H5 availability agrees (taken)", "taken" in (await checkU("PAULA POWER")));
  const h6a = await setU("r1", "ab");
  check("H6a too short rejected", "err" in h6a && h6a.err.includes("short"));
  const h6b = await setU("r1", "bad!chars");
  check("H6b bad charset rejected", "err" in h6b && h6b.err.includes("letters"));
  const h6c = await setU("r1", "-leading");
  check("H6c leading hyphen rejected", "err" in h6c && h6c.err.includes("start"));
  const h6d = await setU("r1", "double  space");
  check("H6d double space rejected", "err" in h6d && h6d.err.includes("double"));
  const h6e = await setU("badguy", "Sneaky");
  check("H6e invalid session cannot set", "err" in h6e && h6e.err.includes("not signed in"));
  check("H6f invalid handle reads invalid", "invalid" in (await checkU("x")));

  g = await gameOf(slug2);
  check("H7 existing byline re-credited (paula → Paula Power)", g && g.owner === "Paula Power", g && g.owner);

  const h8set = await setU("newbie", "Shadow Fox");
  check("H8a newbie picks Shadow Fox", "ok" in h8set);
  const pubN = await publish("newbie", "Fox Game", "FOXY");
  check("H8b publish credits the handle", "ok" in pubN && (await gameOf(pubN.ok)).owner === "Shadow Fox", JSON.stringify(pubN));

  const h9 = await setU("paula", "PPower");
  check("H9a rename ok", "ok" in h9);
  g = await gameOf(slug2);
  check("H9b byline follows the rename", g && g.owner === "PPower", g && g.owner);
  const h9c = await setU("r1", "Paula Power");
  check("H9c rename freed the old handle (r1 claims it)", "ok" in h9c, JSON.stringify(h9c));
  const h9d = await setU("paula", "ppower");
  check("H9d own-handle case change allowed", "ok" in h9d, JSON.stringify(h9d));

  await report("r2", pubN.ok, "testing the log byline");
  const log2 = await modLog();
  check("H10 mod log uses the handle (r2 has none → tag)", log2[0].action === "report" && log2[0].who === "r2", log2[0] && `${log2[0].action}/${log2[0].who}`);
  const r1rep = await report("r1", pubN.ok, "handle in the log");
  check("H11a r1 reports", "ok" in r1rep);
  const log3 = await modLog();
  check("H11b mod log credits r1's handle", log3[0].who === "Paula Power", log3[0] && log3[0].who);

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed, ${findings.length} findings ═══`);
  for (const f of findings) console.log(`  ▲ ${f}`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("DRIVER ERROR:", e.message); process.exit(2); });
