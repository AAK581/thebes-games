/**
 * App — the shell: masthead, hash routes, colophon. One useMemphis
 * instance lives here and is passed down, so the header chip and the
 * upload gate always agree about who is signed in.
 */
import { useEffect, useRef, useState } from "react";
import { useTheme } from "./useTheme";
import { useMemphis } from "./useMemphis";
import { clearAllConsent } from "./memphisDelegation";
import MemphisGate from "./MemphisGate";
import { useHashRoute } from "./router";
import { Frieze, Mark } from "./components";
import Home from "./pages/Home";
import GamePage from "./pages/Game";
import Upload from "./pages/Upload";
import Log from "./pages/Log";

export default function App() {
  const auth = useMemphis();
  const theme = useTheme();
  const route = useHashRoute();
  const [authOpen, setAuthOpen] = useState(false);

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
          title="Catalogue entries are placeholders until the registry canister lands — the three embedded games are real."
        >
          demo shelf
        </span>
        <nav className="mainnav" aria-label="main">
          <a href="#/" {...current("home")}>
            Browse
          </a>
          <a href="#/upload" {...current("upload")}>
            Publish
          </a>
          <a href="#/log" {...current("log")}>
            Log
          </a>
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
        <button
          className="theme-toggle"
          onClick={theme.toggle}
          aria-label={`Switch to ${theme.effective === "dark" ? "light" : "dark"} mode`}
          title={`Switch to ${theme.effective === "dark" ? "light" : "dark"} mode`}
        >
          {theme.effective === "dark" ? "☀" : "☾"}
        </button>
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
        {route.name === "upload" && <Upload auth={auth} />}
        {route.name === "log" && <Log />}
      </main>

      <Frieze />
      <footer className="colophon">
        <span>served from the chain · post-quantum certified · Thebes</span>
        <span>demo catalogue — numbers become real with the registry canister</span>
        <span>
          <a href="#/log">transparency log</a> · <a href="#/upload">house rules</a>
        </span>
      </footer>
    </div>
  );
}
