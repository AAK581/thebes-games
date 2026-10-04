/**
 * Admin — the platform owner's desk. Appoint curators by resolving someone to
 * their Memphis anchor three ways — gaming handle, .thebes identity name, or a
 * pasted anchor id — then add_curator with the tag shown for confirmation. The
 * lookup is EXPLICIT (not a guess-and-fall-back) so a gaming handle "kareem"
 * is never confused with the identity "kareem.thebes".
 *
 * The visibility gate here is cosmetic — anyone can read the bundle and call
 * the endpoints directly. The real checks live on-chain: add_curator verifies
 * the caller's anchor against platformOwner. This page only decides what to
 * SHOW, never what is allowed.
 */
import { useEffect, useState } from "react";
import type { MemphisAuth } from "../useMemphis";
import { resolveAnchorByName, displayTagOf } from "../useMemphis";
import {
  addCurator,
  adoptableGames,
  anchorForUsername,
  openCases,
  type OpenCase,
} from "../registry";

type Mode = "handle" | "identity" | "anchor";

type Resolved = {
  label: string;
  kind: Mode;
  anchor: Uint8Array;
  tag: string;
};

const MODES: { key: Mode; label: string; placeholder: string }[] = [
  { key: "handle", label: "Gaming handle", placeholder: "ShadowFox" },
  { key: "identity", label: "Identity name", placeholder: "kareem.thebes" },
  { key: "anchor", label: "Anchor id", placeholder: "64 hex chars from their identity drawer" },
];

/** Parse a hex anchor id (whitespace tolerated); null if not 32 clean bytes. */
function parseAnchorHex(hex: string): Uint8Array | null {
  const clean = hex.replace(/\s|^0x/gi, "").toLowerCase();
  if (clean.length !== 64 || /[^0-9a-f]/.test(clean)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export default function Admin({
  auth,
  isOwner,
  onRequestSignIn,
}: {
  auth: MemphisAuth;
  /** null = the owner check is still in flight. */
  isOwner: boolean | null;
  onRequestSignIn: () => void;
}) {
  const token = auth.session?.session_token_hex;
  const [mode, setMode] = useState<Mode>("handle");
  const [name, setName] = useState("");
  const [found, setFound] = useState<Resolved | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [cases, setCases] = useState<OpenCase[]>([]);
  const [adoptable, setAdoptable] = useState(0);

  useEffect(() => {
    if (!isOwner) return;
    openCases()
      .then((cs) => setCases(cs.filter((c) => c.resolved === null)))
      .catch(() => setCases([]));
    adoptableGames()
      .then((gs) => setAdoptable(gs.length))
      .catch(() => setAdoptable(0));
  }, [isOwner]);

  // Resolve exactly the way the owner chose — no guessing across kinds.
  async function lookUp() {
    setBusy(true);
    setMsg("");
    setFound(null);
    const q = name.trim();
    try {
      if (mode === "anchor") {
        const anchor = parseAnchorHex(q);
        if (!anchor) {
          setMsg("that isn't a valid anchor id — expected 64 hex characters");
          return;
        }
        setFound({ label: `${q.slice(0, 8)}…`, kind: "anchor", anchor, tag: displayTagOf(anchor) });
      } else if (mode === "handle") {
        const a = await anchorForUsername(q);
        if (a) setFound({ label: q, kind: "handle", anchor: a, tag: displayTagOf(a) });
        else setMsg(`no one has the gaming handle "${q}" — they pick one in the identity drawer`);
      } else {
        // identity name — resolveAnchorByName adds .thebes and validates.
        const r = await resolveAnchorByName(q);
        if (r) setFound({ label: r.name, kind: "identity", anchor: r.anchor, tag: r.tag });
        else setMsg("no identity by that name — a first sign-in here registers it");
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function appoint() {
    if (!token || !found) return;
    setBusy(true);
    setMsg("");
    try {
      await addCurator(token, found.anchor);
      setMsg(`${found.label} is a curator now — publicly logged`);
      setFound(null);
      setName("");
    } catch (e) {
      setMsg("couldn't appoint: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  if (!auth.signedIn) {
    return (
      <>
        <h1 className="pagetitle">Admin</h1>
        <p className="pagelede">
          Sign in to continue.{" "}
          <button className="quiet" onClick={onRequestSignIn}>
            Sign in
          </button>
        </p>
      </>
    );
  }

  if (isOwner === null) {
    return (
      <>
        <h1 className="pagetitle">Admin</h1>
        <p className="pagelede">Checking with the registry…</p>
      </>
    );
  }

  if (!isOwner) {
    return (
      <>
        <h1 className="pagetitle">Admin</h1>
        <p className="pagelede">
          This desk belongs to the platform owner. The backend checks every
          call against the owner's anchor, so there is nothing here for anyone
          else — every action it can take lands in the{" "}
          <a href="#/log">public log</a> anyway.
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="pagetitle">Admin</h1>
      <p className="pagelede">
        The platform owner's desk. Everything done here is an on-chain call
        checked against your anchor and recorded in the{" "}
        <a href="#/log">transparency log</a>.
      </p>

      <section className="panel">
        <h2>Appoint a curator</h2>
        <div className="row modepick">
          {MODES.map((m) => (
            <button
              key={m.key}
              className={m.key === mode ? "" : "secondary"}
              aria-pressed={m.key === mode}
              onClick={() => {
                setMode(m.key);
                setFound(null);
                setMsg("");
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && !busy) void lookUp();
          }}
        >
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setFound(null);
            }}
            placeholder={MODES.find((m) => m.key === mode)!.placeholder}
            aria-label={`Look up by ${mode}`}
          />
          <button type="submit" disabled={busy || !name.trim()}>
            {busy && !found ? "looking up…" : "Look up"}
          </button>
        </form>
        {found && (
          <div className="row">
            <p>
              found <strong>{found.label}</strong>
              <span className="tag"> #{found.tag}</span> (
              {found.kind === "handle"
                ? "gaming handle"
                : found.kind === "identity"
                  ? "identity name"
                  : "anchor id"}
              ) — check the tag with them before appointing.
            </p>
            <button onClick={() => void appoint()} disabled={busy}>
              {busy ? "appointing…" : "Appoint as curator"}
            </button>
          </div>
        )}
        {msg && <p className="hint">{msg}</p>}
        <p className="hint">
          Pick how you're identifying them — a <strong>gaming handle</strong>,
          their <code>.thebes</code> <strong>identity name</strong>, or a
          pasted <strong>anchor id</strong> (they copy it from their identity
          drawer). Choosing the kind avoids a handle like "kareem" being
          mistaken for the identity "kareem.thebes". All three resolve to the
          same anchor the tag confirms. Curators vote on reported games at the
          desk on the <a href="#/log">Log</a> page; a case resolves at 2 votes.
        </p>
      </section>

      <section className="panel">
        <h2>Open cases</h2>
        {cases.length === 0 ? (
          <p className="hint">
            No open cases. You sit on the curator panel too — when a case
            opens, vote at the <a href="#/log">curator desk</a>.
          </p>
        ) : (
          <p>
            {cases.length} open {cases.length === 1 ? "case" : "cases"} —{" "}
            {cases.map((c) => c.slug).join(", ")}. You're a curator too: vote
            at the <a href="#/log">curator desk</a>.
          </p>
        )}
        {adoptable > 0 && (
          <p className="hint">
            {adoptable} unowned house {adoptable === 1 ? "listing" : "listings"}{" "}
            waiting — adopt from <a href="#/mine">Mine</a> to edit{" "}
            {adoptable === 1 ? "it" : "them"}.
          </p>
        )}
      </section>
    </>
  );
}
