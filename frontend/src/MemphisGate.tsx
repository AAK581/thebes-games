/**
 * MemphisGate — the sign-in strip for a Memphis-authenticated app.
 *
 * Signed out: a name field plus a "Sign in with passkey" button. The
 * same control registers a new name or signs into an existing one —
 * Memphis decides by looking the name up first.
 *
 * Signed in: the identity and a sign-out button.
 */
import { useEffect, useState } from "react";
import type { MemphisAuth } from "./useMemphis";
import { setUsername, usernameCheck, type UsernameCheck } from "./registry";

/**
 * The gaming-handle picker. The Memphis name above is an IDENTITY; this is
 * the public byline games and the mod log credit — unique across the site,
 * enforced on-chain (the availability hint here is UX; set_username is the
 * guarantee).
 */
function UsernameField({
  token,
  username,
  onUsernameChange,
}: {
  token: string;
  username: string | null | undefined;
  onUsernameChange: (u: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [avail, setAvail] = useState<UsernameCheck | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  // Prefill once the current handle loads (undefined = still loading).
  useEffect(() => {
    if (typeof username === "string") setDraft(username);
  }, [username]);

  const unchanged =
    typeof username === "string" &&
    draft.trim().toLowerCase() === username.toLowerCase();

  // Debounced live availability — a public query, cheap and non-binding.
  useEffect(() => {
    const d = draft.trim();
    setAvail(null);
    if (!d || unchanged) return;
    const t = setTimeout(() => {
      usernameCheck(d).then(setAvail).catch(() => setAvail(null));
    }, 500);
    return () => clearTimeout(t);
  }, [draft, unchanged]);

  async function save() {
    const d = draft.trim();
    if (!d) return;
    setSaving(true);
    setMsg("");
    try {
      await setUsername(token, d);
      onUsernameChange(d);
      setMsg("saved — your games and log entries now credit it");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (username === undefined) {
    return <p className="hint">gaming handle: checking…</p>;
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!saving && draft.trim() && !unchanged) void save();
      }}
    >
      <label htmlFor="gate-username">Gaming handle</label>
      <input
        id="gate-username"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="ShadowFox"
        maxLength={20}
      />
      <button type="submit" disabled={saving || !draft.trim() || unchanged}>
        {saving ? "saving…" : username ? "Change" : "Claim it"}
      </button>
      {avail && !unchanged && (
        <p className="hint">
          {avail.state === "free" && "free — nobody has it"}
          {avail.state === "taken" && "taken — someone beat you to it"}
          {avail.state === "invalid" && avail.reason}
        </p>
      )}
      {msg && <p className="hint">{msg}</p>}
      <p className="hint">
        The public name on your games and in the transparency log — one holder
        per handle, held on-chain. Your identity name above stays private to
        sign-in.
      </p>
    </form>
  );
}

export default function MemphisGate({
  auth,
  username,
  onUsernameChange,
}: {
  auth: MemphisAuth;
  /** Chosen handle: string = set, null = none, undefined = loading. */
  username: string | null | undefined;
  onUsernameChange: (u: string) => void;
}) {
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);

  if (auth.signedIn) {
    const anchorHex = auth.session?.anchor_id_hex || "";
    const token = auth.session?.session_token_hex || "";
    return (
      <section className="panel memphis">
        <h2>Identity — Memphis passkey</h2>
        <p className="who">
          signed in as <strong>{auth.displayName}</strong>
          {auth.session?.display_tag && (
            <span className="tag"> #{auth.session.display_tag}</span>
          )}
        </p>
        <UsernameField
          token={token}
          username={username}
          onUsernameChange={onUsernameChange}
        />
        {anchorHex && (
          <p className="hint">
            anchor id{" "}
            <code title={anchorHex}>
              {anchorHex.slice(0, 8)}…{anchorHex.slice(-8)}
            </code>{" "}
            <button
              className="quiet"
              onClick={() => {
                void navigator.clipboard.writeText(anchorHex).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? "copied" : "copy"}
            </button>{" "}
            — your public on-chain identifier (an id, not a secret).
          </p>
        )}
        <button onClick={() => void auth.signOut()} disabled={auth.busy}>
          {auth.busy ? "signing out…" : "Sign out"}
        </button>
      </section>
    );
  }

  // A name with no identity yet is not an error — confirm, then register.
  // The two steps exist so a mistyped name cannot silently mint a second
  // identity (and a second passkey) for you.
  if (auth.pendingCreate) {
    return (
      <section className="panel memphis">
        <h2>Identity — Memphis passkey</h2>
        <p className="who">
          No identity exists for <strong>{auth.pendingCreate}</strong> yet.
        </p>
        <div className="row">
          <button onClick={() => void auth.confirmCreate()} disabled={auth.busy}>
            {auth.busy ? "waiting for passkey…" : "Create it with a passkey"}
          </button>
          <button
            className="secondary"
            onClick={auth.cancelCreate}
            disabled={auth.busy}
          >
            Use a different name
          </button>
        </div>
        {auth.error && <p className="error">{auth.error}</p>}
        <p className="hint">
          Creating registers a passkey on this device and claims the name
          on-chain.
        </p>
      </section>
    );
  }

  return (
    <section className="panel memphis">
      <h2>Identity — Memphis passkey</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          // The client requires the `.thebes` suffix; append it rather than
          // making the user learn that from a thrown error.
          const full = n.endsWith(".thebes") ? n : `${n}.thebes`;
          void auth.signIn(full).catch(() => {});
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="yourname.thebes"
          aria-label="Memphis name"
          autoComplete="username webauthn"
        />
        <button type="submit" disabled={auth.busy || !name.trim()}>
          {auth.busy ? "checking…" : "Sign in with passkey"}
        </button>
      </form>
      {auth.error && <p className="error">{auth.error}</p>}
      <p className="hint">
        Names end in <code>.thebes</code> (added for you) with a 3–32
        character stem of <code>a-z 0-9 -</code>. An existing name signs in;
        a new one asks before registering. Requires the app to be served
        from the gateway — passkeys do not work on localhost.
      </p>
    </section>
  );
}
