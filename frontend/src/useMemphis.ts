/**
 * useMemphis — Memphis passkey sign-in, over the proven
 * `window.MemphisPasskey` client (the vendored `passkey.js` loaded by a
 * script tag in index.html).
 *
 * Memphis is Thebes' identity layer — the substrate's Internet Identity
 * equivalent — living at canister 921. A passkey (WebAuthn) sign-in
 * yields a session with a stable anchor id and a display tag; the client
 * persists it in localStorage, so a refresh keeps you signed in.
 *
 * NOTE ON LOCAL DEV: passkey.js pins the WebAuthn relying-party id to
 * `memphis.mercaturaforum.com`, so sign-in only works when the page is
 * served from that origin (i.e. after `thebes-deploy deploy`, at
 * /_/raw/<cid>/index.html). On localhost the browser refuses the
 * credential — the rest of the app still works.
 */
import { useCallback, useEffect, useState } from "react";

export interface MemphisSession {
  name: string;
  anchor_id_hex: string;
  session_token_hex: string;
  expires_at_ns: number;
  display_tag: string;
}

type Passkey = {
  // `confirmCreate: true` is REQUIRED to register a name that does not
  // exist yet — without it the client throws `NameNotRegistered` rather
  // than silently minting an identity for a typo. That guard is why this
  // hook exposes a two-step create flow instead of one call.
  signInOrRegister: (
    name: string,
    opts?: { confirmCreate?: boolean }
  ) => Promise<MemphisSession>;
  loadSession: () => MemphisSession | null;
  signOut: () => Promise<void>;
  // Public name registry (Memphis queries; no session needed).
  lookupAnchor: (name: string) => Promise<Uint8Array | null>;
  validateName: (name: string) => string;
};

function pk(): Passkey {
  const p = (window as unknown as { MemphisPasskey?: Passkey }).MemphisPasskey;
  if (!p) {
    throw new Error(
      "passkey.js not loaded — check the <script src=\"./passkey.js\"> tag in index.html"
    );
  }
  return p;
}

/** The 4-hex-char public tag Memphis derives from an anchor (its last 2 bytes). */
export function displayTagOf(anchor: Uint8Array): string {
  return Array.from(anchor.slice(-2), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Resolve a registered Memphis name to its anchor id — the public
 * `anchor_for_name` query, via passkey.js. Returns null when no identity has
 * claimed the name; throws (with a readable reason) on a malformed name.
 * The anchor id is public — it's the identifier roles are granted to, the
 * substrate's analogue of showing a user their IC principal.
 */
export async function resolveAnchorByName(
  name: string
): Promise<{ name: string; anchor: Uint8Array; tag: string } | null> {
  const n = name.trim().toLowerCase();
  const full = n.endsWith(".thebes") ? n : `${n}.thebes`;
  const valid = pk().validateName(full);
  const anchor = await pk().lookupAnchor(valid);
  return anchor ? { name: valid, anchor, tag: displayTagOf(anchor) } : null;
}

// Treat a session as gone slightly BEFORE its true expiry, so we never hand a
// token to a publish that will out-live it mid-upload (a large game takes
// minutes). `expires_at_ns` is nanoseconds; JS time is ms.
const EXPIRY_SKEW_MS = 60_000;

function msUntilExpiry(s: MemphisSession | null): number {
  if (!s || !s.expires_at_ns) return Infinity; // no expiry info → don't force-out
  return s.expires_at_ns / 1e6 - EXPIRY_SKEW_MS - Date.now();
}

function isExpired(s: MemphisSession | null): boolean {
  return msUntilExpiry(s) <= 0;
}

export interface MemphisAuth {
  session: MemphisSession | null;
  signedIn: boolean;
  /** Short human label for the signed-in identity. */
  displayName: string;
  /** Sign in. An unregistered name sets `pendingCreate` instead of erroring. */
  signIn: (name: string) => Promise<void>;
  /**
   * Name awaiting create confirmation — set when `signIn` found no
   * identity for it. Show a confirm affordance and call `confirmCreate`.
   */
  pendingCreate: string | null;
  /** Register the `pendingCreate` name (prompts for a passkey). */
  confirmCreate: () => Promise<void>;
  /** Abandon the pending create. */
  cancelCreate: () => void;
  signOut: () => Promise<void>;
  busy: boolean;
  error: string | undefined;
}

export function useMemphis(): MemphisAuth {
  const [session, setSession] = useState<MemphisSession | null>(null);
  const [pendingCreate, setPendingCreate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Restore an existing session on mount — but only if it hasn't lapsed. A
  // stale token from yesterday must NOT show as signed-in (the backend would
  // reject the publish with "not signed in" while the UI insists you're on).
  useEffect(() => {
    try {
      const s = pk().loadSession();
      if (s && !isExpired(s)) {
        setSession(s);
      } else if (s) {
        // Lapsed — clear the stored token so it doesn't resurface on reload.
        pk().signOut().catch(() => {});
      }
    } catch {
      /* passkey.js not present yet — leave signed out */
    }
  }, []);

  // Auto sign-out the moment the live session lapses, so the UI flips to
  // signed-out on its own instead of failing the next action.
  useEffect(() => {
    if (!session) return;
    const ms = msUntilExpiry(session);
    if (ms <= 0) {
      setSession(null);
      return;
    }
    if (ms === Infinity) return; // no expiry info
    const timer = setTimeout(() => setSession(null), ms);
    return () => clearTimeout(timer);
  }, [session]);

  const signIn = useCallback(async (name: string) => {
    setBusy(true);
    setError(undefined);
    setPendingCreate(null);
    try {
      // Existing name → WebAuthn assertion. Unregistered name → the client
      // throws `NameNotRegistered` on purpose, so a typo cannot silently
      // create a second identity. Surface it as a confirmable intent.
      setSession(await pk().signInOrRegister(name));
    } catch (e) {
      const code = (e as { code?: string })?.code;
      const requested = (e as { nameRequested?: string })?.nameRequested;
      if (code === "NameNotRegistered") {
        setPendingCreate(requested || name);
        return; // not an error — awaiting confirmation
      }
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const confirmCreate = useCallback(async () => {
    const name = pendingCreate;
    if (!name) return;
    setBusy(true);
    setError(undefined);
    try {
      setSession(await pk().signInOrRegister(name, { confirmCreate: true }));
      setPendingCreate(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [pendingCreate]);

  const cancelCreate = useCallback(() => {
    setPendingCreate(null);
    setError(undefined);
  }, []);

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      await pk().signOut(); // revokes the session on-canister, best effort
    } catch {
      /* best-effort; clear locally regardless */
    } finally {
      setSession(null);
      setBusy(false);
    }
  }, []);

  const live = !!session && !isExpired(session);
  return {
    session: live ? session : null,
    signedIn: live,
    displayName: live ? session!.name || session!.display_tag || "" : "",
    signIn,
    pendingCreate,
    confirmCreate,
    cancelCreate,
    signOut,
    busy,
    error,
  };
}
