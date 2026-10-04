/**
 * Admin — the platform owner's desk. Appoint curators by NAME: the form
 * resolves a .thebes handle to its Memphis anchor via the public
 * `anchor_for_name` query, shows the tag for confirmation, then calls the
 * backend's add_curator. No more devtools candid rituals.
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

type Resolved = {
  label: string;
  kind: "handle" | "identity";
  anchor: Uint8Array;
  tag: string;
};

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

  // Resolve a gaming handle first (what the owner is likeliest to know),
  // then fall back to a .thebes identity name. Either yields an anchor.
  async function lookUp() {
    setBusy(true);
    setMsg("");
    setFound(null);
    const q = name.trim();
    try {
      const byHandle = await anchorForUsername(q);
      if (byHandle) {
        setFound({ label: q, kind: "handle", anchor: byHandle, tag: displayTagOf(byHandle) });
        return;
      }
      // Not a known handle — try it as an identity name (adds .thebes itself;
      // a malformed one throws, which we surface).
      try {
        const byName = await resolveAnchorByName(q);
        if (byName) {
          setFound({ label: byName.name, kind: "identity", anchor: byName.anchor, tag: byName.tag });
          return;
        }
      } catch {
        /* not a valid identity name either — fall through to the hint */
      }
      setMsg(
        "no gaming handle or identity by that name — they need to sign in here once (and, for a handle, pick one in the identity drawer)"
      );
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
            placeholder="gaming handle or name.thebes"
            aria-label="Gaming handle or Memphis name to appoint"
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
              {found.kind === "handle" ? "gaming handle" : "identity name"}) —
              check the tag with them before appointing.
            </p>
            <button onClick={() => void appoint()} disabled={busy}>
              {busy ? "appointing…" : "Appoint as curator"}
            </button>
          </div>
        )}
        {msg && <p className="hint">{msg}</p>}
        <p className="hint">
          Enter their gaming handle or their <code>.thebes</code> sign-in name
          — either resolves to their anchor, so nobody copies ids around. A
          handle needs them to have picked one; an identity name just needs one
          sign-in here. Curators vote on reported games at the desk on the{" "}
          <a href="#/log">Log</a> page; a case resolves at 2 votes.
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
