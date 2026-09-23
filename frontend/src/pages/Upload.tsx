/**
 * Upload — the publish flow, next to the house rules it binds you to.
 *
 * The form is UI-complete but submits nowhere yet: publishing lands with
 * the registry + vault canisters (chunked upload, 32 KiB discipline).
 * Publishing requires a Memphis identity — the gate renders inline when
 * signed out.
 */
import { useState } from "react";
import type { MemphisAuth } from "../useMemphis";
import MemphisGate from "../MemphisGate";
import type { Rating } from "../data";

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function Upload({ auth }: { auth: MemphisAuth }) {
  const [title, setTitle] = useState("");
  const [taglineText, setTaglineText] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [rating, setRating] = useState<Rating | null>(null);
  const [attested, setAttested] = useState(false);

  const ready =
    auth.signedIn && title.trim() !== "" && rating !== null && attested;

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
                Publishing requires a Memphis passkey identity — your games
                are owned by your anchor, on chain.
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
            />
          </div>

          <div className="field">
            <label htmlFor="up-desc">Description</label>
            <textarea
              id="up-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is it, how does it play, what should a stranger expect?"
            />
          </div>

          <div className="field">
            <label htmlFor="up-tags">Tags</label>
            <input
              id="up-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="arcade, 2d, cards — up to five"
            />
          </div>

          <div className="field">
            <span className="label">Rating — your declaration, on the record</span>
            <div className="ratingpick">
              <label>
                <input
                  type="radio"
                  name="rating"
                  checked={rating === "E"}
                  onChange={() => setRating("E")}
                />
                <span>
                  <b>E · everyone</b> — no violence beyond cartoon slapstick, no
                  strong language.
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="rating"
                  checked={rating === "T"}
                  onChange={() => setRating("T")}
                />
                <span>
                  <b>T · teen</b> — stylized combat, mild language, tense themes.
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="rating"
                  checked={rating === "M"}
                  onChange={() => setRating("M")}
                />
                <span>
                  <b>M · mature</b> — realistic violence, strong language. Still
                  no sexual content — there is no rating for that here.
                </span>
              </label>
            </div>
            <p className="sub">
              Misdeclaring a rating is a strikeable offense, judged by curator
              panel.
            </p>
          </div>

          <div className="field">
            <span className="label">Cover — 315 × 250 or larger</span>
            <div className="dropzone">
              drop an image here, or leave it and the shelf draws you a
              geometric one
            </div>
          </div>

          <div className="field">
            <span className="label">Game bundle — .zip with index.html at root</span>
            <div className="dropzone">
              drop your build here · 16 MB cap while the vault is young
            </div>
          </div>

          <label className="attest">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
            />
            <span>
              This is my work (or licensed to me), it matches the rating I
              declared, and it follows the house rules. I understand this
              attestation is recorded on chain with my anchor.
            </span>
          </label>

          <button disabled={!ready} title="lands with the registry canister">
            Publish to the shelves
          </button>
          <p className="hint">
            The publish pipeline ships with the registry + vault canisters —
            this form is the front of it.
          </p>
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
