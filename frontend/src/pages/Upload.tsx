/**
 * Upload — the real publish flow: pick a web build (.zip with index.html at
 * root), it's unzipped in the browser, chunked, and streamed to the vault
 * canister (gated by your Memphis session), then it goes live in the registry
 * and plays from /_/raw/<vault>/g/<slug>/.
 */
import { useState } from "react";
import { unzipSync } from "fflate";
import type { MemphisAuth } from "../useMemphis";
import type { Rating } from "../data";
import { beginPublish, putChunk, finishPublish, setCover } from "../registry";
import { TagsInput, ResolutionFields, RatingPick } from "../components";
import { TAG_MAX_COUNT } from "../tagPolicy";
import { prepareCover, COVER_MAX_DIM } from "../coverPrep";

// Honor the substrate's ~32 KiB chunk discipline, with headroom for the
// Candid framing (token + slug + path) around the bytes.
const CHUNK = 32 * 1000;
// No separate per-file cap — files are served via the streaming callback, so a
// single file is bounded only by the per-game total.
const MAX_TOTAL = 256 * 1024 * 1024; // 256 MB / game
const MAX_FILE = MAX_TOTAL;
const MAX_FILES = 4096;
const MAX_TAGS = TAG_MAX_COUNT;
// Upload several files at once for throughput. The submit step is serialized
// globally in thebes.ts (nonces MUST arrive in order or the chain rejects the
// lower ones as replays), so this concurrency only overlaps the RECEIPT waits —
// which is where the wall-clock savings are. It also bounds how many chunks sit
// un-finalized in the node's pool at once (≤ CONCURRENCY × CHUNK ≈ 128 KB),
// well under the substrate's inline-block ceiling. Chunks WITHIN a file stay
// sequential (the vault appends in arrival order); only distinct files overlap.
const UPLOAD_CONCURRENCY = 4;

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Drop directory entries; if there's no root index.html but a single top
    folder holds one, strip that prefix (zipping a folder is the common case). */
function normalizeZip(raw: Record<string, Uint8Array>): Record<string, Uint8Array> {
  let files: Record<string, Uint8Array> = {};
  for (const [p, b] of Object.entries(raw)) if (!p.endsWith("/")) files[p] = b;
  if (!("index.html" in files)) {
    const paths = Object.keys(files);
    const top = paths[0]?.split("/")[0];
    if (top && paths.every((p) => p.startsWith(top + "/")) && top + "/index.html" in files) {
      const stripped: Record<string, Uint8Array> = {};
      for (const p of paths) stripped[p.slice(top.length + 1)] = files[p];
      files = stripped;
    }
  }
  return files;
}

function validate(files: Record<string, Uint8Array>) {
  if (!("index.html" in files)) {
    throw new Error(
      "the bundle needs index.html at its root (or a single top folder containing it)"
    );
  }
  const entries = Object.entries(files);
  if (entries.length > MAX_FILES) throw new Error(`too many files (${MAX_FILES} max)`);
  let total = 0;
  for (const [p, b] of entries) {
    if (b.length > MAX_FILE) throw new Error(`"${p}" is over the 256 MB cap`);
    total += b.length;
  }
  if (total > MAX_TOTAL) throw new Error("the bundle is over 256 MB");
}

type Phase = "idle" | "working" | "done" | "error";

export default function Upload({
  auth,
  onRequestSignIn,
}: {
  auth: MemphisAuth;
  onRequestSignIn: () => void;
}) {
  const [title, setTitle] = useState("");
  const [taglineText, setTaglineText] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [rating, setRating] = useState<Rating | null>(null);
  const [resW, setResW] = useState(816); // RPG Maker MZ default
  const [resH, setResH] = useState(624);
  const [attested, setAttested] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [cover, setCoverState] = useState<
    { bytes: Uint8Array; type: string; w: number; h: number; name: string } | null
  >(null);
  const [coverErr, setCoverErr] = useState("");
  const [coverBusy, setCoverBusy] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0); // 0..1
  const [statusMsg, setStatusMsg] = useState("");
  const [fileCount, setFileCount] = useState<[number, number] | null>(null); // [done, total]
  const [error, setError] = useState("");
  const [publishedSlug, setPublishedSlug] = useState("");

  async function onCoverPick(f: File | null) {
    setCoverErr("");
    if (!f) {
      setCoverState(null);
      return;
    }
    setCoverBusy(true);
    try {
      const prep = await prepareCover(f);
      setCoverState({ ...prep, name: f.name });
    } catch (e) {
      setCoverState(null);
      setCoverErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCoverBusy(false);
    }
  }

  const busy = phase === "working";
  const ready =
    auth.signedIn && title.trim() !== "" && rating !== null && attested && file !== null;

  async function publish() {
    const token = auth.session?.session_token_hex;
    if (!token || !file || !rating) return;
    setError("");
    setProgress(0);
    setFileCount(null);
    setPhase("working");
    const zipName = file.name;
    try {
      setStatusMsg(`Reading ${zipName}…`);
      const zipBytes = new Uint8Array(await file.arrayBuffer());
      const files = normalizeZip(unzipSync(zipBytes));
      validate(files);

      setStatusMsg("Registering…");
      const slug = await beginPublish(token, {
        title: title.trim(),
        tagline: taglineText.trim(),
        description: description.trim(),
        tags: tags.slice(0, MAX_TAGS),
        rating,
        resW,
        resH,
      });

      const entries = Object.entries(files);
      const totalBytes = entries.reduce((a, [, b]) => a + b.length, 0);
      // Progress accumulators. JS is single-threaded, so the workers below
      // interleave only at awaits — these increments never race.
      let sent = 0;
      let filesDone = 0;
      setFileCount([0, entries.length]);
      // Show the zip the user picked, not whatever internal path is mid-flight
      // — no one thinks in terms of "effects/Texture/Rhombus2.png".
      setStatusMsg(`Uploading ${zipName}`);

      let next = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= entries.length) return;
          const [path, bytes] = entries[i];
          if (bytes.length === 0) {
            await putChunk(token, slug, path, bytes); // register the empty file
          } else {
            for (let off = 0; off < bytes.length; off += CHUNK) {
              const chunk = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
              await putChunk(token, slug, path, chunk); // chunks in order per file
              sent += chunk.length;
              setProgress(totalBytes ? sent / totalBytes : 1);
            }
          }
          filesDone++;
          setFileCount([filesDone, entries.length]);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, entries.length) }, worker)
      );

      if (cover) {
        setStatusMsg("Uploading cover…");
        // Non-fatal: a failed cover still leaves the game published (drawn art).
        await setCover(token, slug, cover.type, cover.bytes).catch(() => {});
      }

      setStatusMsg("Finalizing…");
      await finishPublish(token, slug);
      setPublishedSlug(slug);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  if (phase === "done") {
    return (
      <div className="publishdone">
        <h1 className="pagetitle">Published ✓</h1>
        <p className="pagelede">
          <strong>{title.trim()}</strong> is live on the shelves, served from the
          vault.
        </p>
        <div className="actions">
          <a className="btn" href={`#/game/${publishedSlug}`}>
            ▶ Open its page
          </a>
          <a className="btn secondary" href="#/">
            Back to browse
          </a>
        </div>
      </div>
    );
  }

  return (
    <>
      <h1 className="pagetitle">Publish a game</h1>
      <p className="pagelede">
        Web builds only — HTML, JS, WASM. Your bundle is stored on chain and
        served from the vault, sandboxed, to everyone.
      </p>

      <div className="publish">
        <div>
          {!auth.signedIn && (
            <p className="hint">
              Publishing requires a Memphis passkey identity — your games are
              owned by your anchor, on chain.{" "}
              <button className="quiet" onClick={onRequestSignIn}>
                Sign in
              </button>
            </p>
          )}

          <div className="field">
            <label htmlFor="up-title">Title</label>
            <input
              id="up-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Duat Runner"
              disabled={busy}
            />
          </div>

          {title.trim() && (
            <div className="field slugline">
              <span className="label">Shelf address</span>
              <code>#/game/{slugify(title)}</code>
            </div>
          )}

          <div className="field">
            <label htmlFor="up-tagline">Tagline</label>
            <input
              id="up-tagline"
              value={taglineText}
              onChange={(e) => setTaglineText(e.target.value)}
              placeholder="One line that sells the run."
              disabled={busy}
            />
          </div>

          <div className="field">
            <label htmlFor="up-desc">Description</label>
            <textarea
              id="up-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is it, how does it play, what should a stranger expect?"
              disabled={busy}
            />
          </div>

          <div className="field">
            <label htmlFor="up-res-w">Game resolution (px)</label>
            <ResolutionFields
              w={resW}
              h={resH}
              onW={setResW}
              onH={setResH}
              disabled={busy}
              idPrefix="up-res"
            />
            <p className="hint">
              Your game's native size, so it fills the player without black bars.
              RPG Maker MZ is 816×624; 2560 max per side.
            </p>
          </div>

          <div className="field">
            <label htmlFor="up-tags">Tags</label>
            <TagsInput tags={tags} onTags={setTags} disabled={busy} id="up-tags" />
          </div>

          <div className="field">
            <span className="label">Rating — your declaration, on the record</span>
            <RatingPick value={rating} onChange={setRating} disabled={busy} />
            <p className="sub">
              Misdeclaring a rating is a strikeable offense, judged by curator
              panel.
            </p>
          </div>

          <div className="field">
            <span className="label">
              Game bundle — .zip with index.html at root · 256 MB cap · big files streamed
            </span>
            <label className="dropzone">
              <input
                type="file"
                accept=".zip,application/zip"
                style={{ display: "none" }}
                disabled={busy}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file
                ? `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB — click to replace`
                : "click to choose your build .zip"}
            </label>
          </div>

          <div className="field">
            <span className="label">
              Cover image — optional (PNG/JPG/WebP · max {COVER_MAX_DIM}px · 2 MB · auto-shrunk)
            </span>
            <label className="dropzone">
              <input
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                disabled={busy || coverBusy}
                onChange={(e) => void onCoverPick(e.target.files?.[0] ?? null)}
              />
              {coverBusy
                ? "processing…"
                : cover
                ? `${cover.name} · ${cover.w}×${cover.h} · ${(cover.bytes.length / 1024).toFixed(0)} KB — click to replace`
                : "choose a cover, or leave it and the shelf draws one from the title"}
            </label>
            {coverErr && <p className="error">{coverErr}</p>}
          </div>

          <label className="attest">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
              disabled={busy}
            />
            <span>
              This is my work (or licensed to me), it matches the rating I
              declared, and it follows the house rules. I understand this
              attestation is recorded on chain with my anchor.
            </span>
          </label>

          <button disabled={!ready || busy} onClick={() => void publish()}>
            {busy ? "Publishing…" : "Publish to the shelves"}
          </button>

          {phase === "working" && (
            <div className="uploadprogress">
              <div className="bar">
                <span style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <p className="hint">
                {statusMsg} · {Math.round(progress * 100)}%
                {fileCount && ` · ${fileCount[0]}/${fileCount[1]} files`}
              </p>
            </div>
          )}
          {phase === "error" && <p className="error">Publish failed — {error}</p>}
        </div>

        <aside className="panel houserules">
          <h2>House rules</h2>

          <h3>Not on these shelves</h3>
          <ul>
            <li>No sexual or pornographic content — no adult tier exists.</li>
            <li>
              Nothing illegal: CSAM, malware, doxxing. Two curators can freeze
              serving instantly; a full panel must ratify within 72h.
            </li>
            <li>No harassment, impersonation, or targeting real people.</li>
            <li>No stolen games or ripped assets.</li>
          </ul>

          <h3>How enforcement works</h3>
          <ol>
            <li>Weighted community reports quarantine a game at a threshold.</li>
            <li>A randomly-drawn panel of 3 curators decides within 72h.</li>
            <li>Restore — or delist, with a strike where deserved.</li>
            <li>One appeal, to a panel of 5.</li>
          </ol>

          <h3>Strikes</h3>
          <ul>
            <li>3 strikes → publishing suspended 30 days.</li>
            <li>5 strikes → publishing rights removed.</li>
          </ul>

          <p className="fine">
            every action lands on the <a href="#/log">public log</a> · new
            accounts: 2 uploads/week in their first month
          </p>
        </aside>
      </div>
    </>
  );
}
