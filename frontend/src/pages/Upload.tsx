/**
 * Upload — the real publish flow: pick a web build (.zip with index.html at
 * root), it's unzipped in the browser, chunked, and streamed to the vault
 * canister (gated by your Memphis session), then it goes live in the registry
 * and plays from /_/raw/<vault>/g/<slug>/.
 */
import { useState } from "react";
import { unzipSync } from "fflate";
import type { MemphisAuth } from "../useMemphis";
import MemphisGate from "../MemphisGate";
import type { Rating } from "../data";
import { beginPublish, putChunk, finishPublish, setCover } from "../registry";

// Honor the substrate's ~32 KiB chunk discipline, with headroom for the
// Candid framing (token + slug + path) around the bytes.
const CHUNK = 32 * 1000;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
const MAX_FILES = 512;

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseTags(s: string): string[] {
  return s
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "")
    .slice(0, 5);
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
    if (b.length > MAX_FILE) throw new Error(`"${p}" is over 2 MB (per-file cap)`);
    total += b.length;
  }
  if (total > MAX_TOTAL) throw new Error("the bundle is over 16 MB");
}

type Phase = "idle" | "working" | "done" | "error";

export default function Upload({ auth }: { auth: MemphisAuth }) {
  const [title, setTitle] = useState("");
  const [taglineText, setTaglineText] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [rating, setRating] = useState<Rating | null>(null);
  const [attested, setAttested] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0); // 0..1
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState("");
  const [publishedSlug, setPublishedSlug] = useState("");

  const busy = phase === "working";
  const ready =
    auth.signedIn && title.trim() !== "" && rating !== null && attested && file !== null;

  async function publish() {
    const token = auth.session?.session_token_hex;
    if (!token || !file || !rating) return;
    setError("");
    setProgress(0);
    setPhase("working");
    try {
      setStatusMsg("reading the bundle…");
      const zipBytes = new Uint8Array(await file.arrayBuffer());
      const files = normalizeZip(unzipSync(zipBytes));
      validate(files);

      setStatusMsg("registering…");
      const slug = await beginPublish(token, {
        title: title.trim(),
        tagline: taglineText.trim(),
        description: description.trim(),
        tags: parseTags(tags),
        rating,
      });

      const totalBytes = Object.values(files).reduce((a, b) => a + b.length, 0);
      let sent = 0;
      for (const [path, bytes] of Object.entries(files)) {
        if (bytes.length === 0) {
          await putChunk(token, slug, path, bytes); // register the empty file
          continue;
        }
        for (let off = 0; off < bytes.length; off += CHUNK) {
          const chunk = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
          await putChunk(token, slug, path, chunk);
          sent += chunk.length;
          setProgress(totalBytes ? sent / totalBytes : 1);
          setStatusMsg(`uploading ${path}`);
        }
      }

      if (coverFile) {
        setStatusMsg("uploading cover…");
        const cbytes = new Uint8Array(await coverFile.arrayBuffer());
        // Non-fatal: a failed cover still leaves the game published (drawn art).
        await setCover(token, slug, coverFile.type || "image/png", cbytes).catch(() => {});
      }

      setStatusMsg("finalizing…");
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
            <>
              <p className="hint">
                Publishing requires a Memphis passkey identity — your games are
                owned by your anchor, on chain.
              </p>
              <MemphisGate auth={auth} />
            </>
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
            <label htmlFor="up-tags">Tags</label>
            <input
              id="up-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="arcade, 2d, cards — up to five"
              disabled={busy}
            />
          </div>

          <div className="field">
            <span className="label">Rating — your declaration, on the record</span>
            <div className="ratingpick">
              {(["E", "T", "M"] as Rating[]).map((r) => (
                <label key={r}>
                  <input
                    type="radio"
                    name="rating"
                    checked={rating === r}
                    onChange={() => setRating(r)}
                    disabled={busy}
                  />
                  <span>
                    {r === "E" ? (
                      <>
                        <b>E · everyone</b> — no violence beyond cartoon slapstick,
                        no strong language.
                      </>
                    ) : r === "T" ? (
                      <>
                        <b>T · teen</b> — stylized combat, mild language, tense
                        themes.
                      </>
                    ) : (
                      <>
                        <b>M · mature</b> — realistic violence, strong language.
                        Still no sexual content — there is no rating for that here.
                      </>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <p className="sub">
              Misdeclaring a rating is a strikeable offense, judged by curator
              panel.
            </p>
          </div>

          <div className="field">
            <span className="label">
              Game bundle — .zip with index.html at root · 16 MB cap, 2 MB/file
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
            <span className="label">Cover image — optional (PNG/JPG/WebP, 2 MB max)</span>
            <label className="dropzone">
              <input
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                disabled={busy}
                onChange={(e) => setCoverFile(e.target.files?.[0] ?? null)}
              />
              {coverFile
                ? `${coverFile.name} — click to replace`
                : "choose a cover, or leave it and the shelf draws one from the title"}
            </label>
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
              </p>
            </div>
          )}
          {phase === "error" && <p className="error">Publish failed — {error}</p>}
          {!auth.signedIn && (
            <p className="hint">Sign in above to publish.</p>
          )}
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
