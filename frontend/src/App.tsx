/**
 * App — the shell: masthead, hash routes, colophon. One useMemphis
 * instance lives here and is passed down, so the header chip and the
 * upload gate always agree about who is signed in.
 */
import { useEffect, useRef, useState } from "react";
import { useMemphis } from "./useMemphis";
import { clearAllConsent } from "./memphisDelegation";
import MemphisGate from "./MemphisGate";
import { useHashRoute } from "./router";
import { Frieze, Mark } from "./components";
import { amIOwner } from "./registry";
import Home from "./pages/Home";
import GamePage from "./pages/Game";
import Upload from "./pages/Upload";
import MyGames from "./pages/MyGames";
import Log from "./pages/Log";
import Admin from "./pages/Admin";

export default function App() {
  const auth = useMemphis();
  const route = useHashRoute();
  const [authOpen, setAuthOpen] = useState(false);

  // Is this the platform owner? Drives the Admin nav link and the admin
  // page's gate — display only; the backend re-checks every owner call.
  // null = check in flight (so #/admin doesn't flash "not yours" at the
  // owner while the registry answers).
  const token = auth.session?.session_token_hex;
  const [isOwner, setIsOwner] = useState<boolean | null>(false);
  useEffect(() => {
    if (!token) {
      setIsOwner(false);
      return;
    }
    let stale = false;
    setIsOwner(null);
    amIOwner(token)
      .then((v) => !stale && setIsOwner(v))
      .catch(() => !stale && setIsOwner(false));
    return () => {
      stale = true;
    };
  }, [token]);

  // Per-game delegated-sign-in consent is remembered until the platform
  // signs out (spec §5.1). Drop it all on the signed-in → signed-out edge.
  const prevSignedIn = useRef(auth.signedIn);
  useEffect(() => {
    if (prevSignedIn.current && !auth.signedIn) clearAllConsent();
    prevSignedIn.current = auth.signedIn;
  }, [auth.signedIn]);

  const current = (name: string) =>
    route.name === name ? { "aria-current": "page" as const } : {};

  return (
    <div className="site">
      <header className="masthead">
        <a className="wordmark" href="#/">
          <Mark />
          <span className="name">Thebes Games</span>
        </a>
        <span
          className="chip"
          title="The catalogue is live from the on-chain registry — anyone can publish, every game owned by its anchor."
        >
          on-chain shelf
        </span>
        <nav className="mainnav" aria-label="main">
          <a href="#/" {...current("home")}>
            Browse
          </a>
          <a href="#/upload" {...current("upload")}>
            Publish
          </a>
          <a href="#/mine" {...current("mine")}>
            Mine
          </a>
          <a href="#/log" {...current("log")}>
            Log
          </a>
          {isOwner === true && (
            <a href="#/admin" {...current("admin")}>
              Admin
            </a>
          )}
        </nav>
        {auth.signedIn ? (
          <button className="quiet authchip" onClick={() => setAuthOpen(!authOpen)}>
            ⊙ {auth.displayName}
          </button>
        ) : (
          <button
            className="secondary authchip"
            onClick={() => setAuthOpen(!authOpen)}
          >
            Sign in
          </button>
        )}
      </header>
      <Frieze />

      {authOpen && (
        <div className="authdrawer">
          <MemphisGate auth={auth} />
        </div>
      )}

      <main>
        {route.name === "home" && <Home />}
        {route.name === "game" && (
          <GamePage
            slug={route.slug}
            auth={auth}
            onRequestSignIn={() => setAuthOpen(true)}
          />
        )}
        {route.name === "upload" && (
          <Upload auth={auth} onRequestSignIn={() => setAuthOpen(true)} />
        )}
        {route.name === "mine" && (
          <MyGames auth={auth} onRequestSignIn={() => setAuthOpen(true)} />
        )}
        {route.name === "log" && <Log auth={auth} />}
        {route.name === "admin" && (
          <Admin
            auth={auth}
            isOwner={isOwner}
            onRequestSignIn={() => setAuthOpen(true)}
          />
        )}
      </main>

      <Frieze />
      <footer className="colophon">
        <span>served from the chain · post-quantum certified · Thebes</span>
        <span>registry + vault live — publish your own, owned by your anchor</span>
        <span>
          <a href="#/log">transparency log</a> · <a href="#/upload">house rules</a>
        </span>
      </footer>
    </div>
  );
}
