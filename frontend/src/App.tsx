import { useEffect, useState } from "react";
import { call, encodeEmpty, encodeText, query } from "./thebes";
import { useTheme } from "./useTheme";
import { useMemphis } from "./useMemphis";
import MemphisGate from "./MemphisGate";

export default function App() {
  const auth = useMemphis();
  const theme = useTheme();
  const [name, setName] = useState("");
  const [greeting, setGreeting] = useState<string | null>(null);
  const [count, setCount] = useState<bigint | null>(null);
  const [countFailed, setCountFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshCount() {
    try {
      const v = await query("get_count", encodeEmpty());
      setCount(typeof v === "bigint" ? v : null);
      setCountFailed(false);
    } catch (e) {
      // Show the failure instead of leaving the counter on "…" forever.
      setCountFailed(true);
      setError(String(e));
    }
  }

  useEffect(() => {
    void refreshCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onGreet(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      // Signed in? Greet the Memphis identity by name.
      const who = name || auth.displayName || "traveller";
      const v = await query("greet", encodeText(who));
      setGreeting(String(v));
    } catch (e) {
      setError(String(e));
    }
  }

  async function onIncrement() {
    setError(null);
    setBusy(true);
    try {
      const v = await call("increment", encodeEmpty());
      if (typeof v === "bigint") setCount(v);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header>
        {/* Follows the OS by default; this flips to an explicit choice
            that persists (scoped to this app — see useTheme). */}
        <button
          className="theme-toggle"
          onClick={theme.toggle}
          aria-label={`Switch to ${theme.effective === "dark" ? "light" : "dark"} mode`}
          title={`Switch to ${theme.effective === "dark" ? "light" : "dark"} mode`}
        >
          {theme.effective === "dark" ? "☀" : "☾"}
        </button>
        <div className="cartouche">𓊹</div>
        <h1>thebes-games</h1>
        <p className="strap">a canister dapp, live on the Thebes substrate</p>
      </header>

      <MemphisGate auth={auth} />

      <section className="panel">
        <h2>Query — answered locally, no consensus</h2>
        <form onSubmit={onGreet}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={auth.signedIn ? auth.displayName : "your name"}
            aria-label="name to greet"
          />
          <button type="submit">Greet</button>
        </form>
        {greeting && <p className="reply">{greeting}</p>}
      </section>

      <section className="panel">
        <h2>Update — ordered by consensus, finalized on chain</h2>
        <p className="count">
          counter:{" "}
          <strong>
            {count !== null ? count.toString() : countFailed ? "unavailable" : "…"}
          </strong>
        </p>
        <button onClick={onIncrement} disabled={busy}>
          {busy ? "finalizing…" : "Increment"}
        </button>
        {!auth.signedIn && (
          <p className="hint">
            Tip: this starter lets anyone increment. Gate it on{" "}
            <code>auth.signedIn</code> — and check the session token in your
            backend — when you want real per-user rules.
          </p>
        )}
      </section>

      {error && <p className="error">{error}</p>}

      <footer>served from the chain · post-quantum certified · Thebes</footer>
    </main>
  );
}
