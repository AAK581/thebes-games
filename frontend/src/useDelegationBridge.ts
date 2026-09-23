/**
 * useDelegationBridge — the platform-side runtime for Memphis Delegated
 * Sessions (docs/memphis-delegated-sessions.md). Lives in PlayerShell and,
 * while a game is running, answers the game SDK's postMessage handshake:
 * mints an audience-scoped delegated token, posts it to the frame, renews
 * it before expiry, and revokes it on stop / sign-out.
 *
 * DORMANT unless `DELEGATION_ENABLED` (window.THEBES_DELEGATION === true).
 * When off, this attaches no listeners and changes nothing.
 *
 * The security-critical decisions are delegated to the pure reducer and
 * builders in memphisDelegation.ts (unit-tested); this hook is the effectful
 * shell that ties them to the iframe and Memphis.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Game } from "./data";
import type { MemphisAuth } from "./useMemphis";
import {
  DELEGATION_ENABLED,
  DELEGATION_TTL_NS,
  audienceFor,
  buildRevokedMessage,
  buildSessionMessage,
  buildSignedOutMessage,
  hasConsent,
  grantConsent,
  isFromFrame,
  openDelegatedSession,
  parseInbound,
  reduceGameMessage,
  revokeDelegation,
} from "./memphisDelegation";

export interface ConsentRequest {
  gameName: string;
  anchorName: string;
  onAllow: () => void;
  onDeny: () => void;
}

interface Params {
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  game: Game;
  auth: MemphisAuth;
  /** True only while the game is actually running in the frame. */
  running: boolean;
  /** Open the platform's own (top-level) sign-in. */
  onRequestSignIn: () => void;
}

export function useDelegationBridge({
  frameRef,
  game,
  auth,
  running,
  onRequestSignIn,
}: Params): { consent: ConsentRequest | null } {
  const [consent, setConsent] = useState<ConsentRequest | null>(null);

  // Latest auth + callback, read inside the stable message handler so the
  // listener needn't re-attach on every render.
  const authRef = useRef(auth);
  authRef.current = auth;
  const onSignInRef = useRef(onRequestSignIn);
  onSignInRef.current = onRequestSignIn;

  const channelIdRef = useRef<string>("");
  const tokenRef = useRef<string | null>(null); // live deleg token, for revoke
  const genRef = useRef(0); // bumps to abort stale async issuance
  const reissueTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const frameWindow = useCallback(
    () => frameRef.current?.contentWindow ?? null,
    [frameRef]
  );

  const postToFrame = useCallback(
    (msg: unknown) => {
      // Opaque-origin frame → targetOrigin must be "*"; we only ever post to
      // this specific contentWindow, and the only sensitive payload is the
      // (already audience-scoped) delegated token.
      frameWindow()?.postMessage(msg, "*");
    },
    [frameWindow]
  );

  const clearReissue = () => {
    if (reissueTimer.current) {
      clearTimeout(reissueTimer.current);
      reissueTimer.current = null;
    }
  };

  const revokeCurrent = useCallback(() => {
    const t = tokenRef.current;
    tokenRef.current = null;
    clearReissue();
    if (t) void revokeDelegation(t).catch(() => {});
  }, []);

  // `issueAndPost` and the re-issue timer reference each other; a ref breaks
  // the cycle (the timer always calls the latest issuer). `runningRef` lets
  // async continuations read the current running-state without re-binding.
  const issueRef = useRef<() => Promise<void>>(async () => {});
  const runningRef = useRef(running);
  runningRef.current = running;

  const scheduleReissue = useCallback((expiresAtNs: string) => {
    clearReissue();
    let ms: number;
    try {
      const expMs = Number(BigInt(expiresAtNs) / 1_000_000n);
      ms = expMs - Date.now() - 30_000; // renew ~30s before expiry
    } catch {
      ms = Number(DELEGATION_TTL_NS / 1_000_000n) - 30_000;
    }
    if (!Number.isFinite(ms) || ms < 5_000) ms = 5_000;
    reissueTimer.current = setTimeout(() => {
      if (runningRef.current && tokenRef.current) void issueRef.current();
    }, ms);
  }, []);

  const issueAndPost = useCallback(async () => {
    const session = authRef.current.session;
    const audience = audienceFor(game);
    if (!session || !audience) {
      postToFrame(buildSignedOutMessage(channelIdRef.current));
      return;
    }
    const gen = ++genRef.current;
    revokeCurrent(); // retire any previous token before minting a fresh one
    try {
      const { delegTokenHex, expiresAtNs } = await openDelegatedSession(
        session,
        audience,
        DELEGATION_TTL_NS
      );
      // Boot changed / stopped while minting → don't post into a stale or
      // gone frame; retire the token we just made.
      if (gen !== genRef.current || !runningRef.current) {
        void revokeDelegation(delegTokenHex).catch(() => {});
        return;
      }
      tokenRef.current = delegTokenHex;
      postToFrame(
        buildSessionMessage(
          channelIdRef.current,
          delegTokenHex,
          { display_tag: session.display_tag, name: session.name },
          expiresAtNs
        )
      );
      scheduleReissue(expiresAtNs);
    } catch {
      // Couldn't mint (chain method absent, network, expired parent) — be
      // honest and tell the game it's signed out rather than hang.
      if (gen === genRef.current) {
        postToFrame(buildSignedOutMessage(channelIdRef.current));
      }
    }
  }, [game, postToFrame, revokeCurrent, scheduleReissue]);
  issueRef.current = issueAndPost;

  // Attach the handshake listener while running. Re-attaches only when the
  // game or running-state changes, not on every auth render.
  useEffect(() => {
    if (!DELEGATION_ENABLED || !running) return;

    // Fresh channel per boot; disambiguates windows (not a secret).
    channelIdRef.current = randomId();
    genRef.current++;

    const handler = (event: MessageEvent) => {
      if (!isFromFrame(event.source, frameWindow())) return;
      const msg = parseInbound(event.data);
      if (!msg) return;
      // After the hello, messages must echo our channel id.
      if ("channelId" in msg && msg.channelId !== channelIdRef.current) return;

      const action = reduceGameMessage(msg, {
        channelId: channelIdRef.current,
        signedIn: authRef.current.signedIn,
        audience: audienceFor(game),
        hasConsent: hasConsent(game.slug),
      });

      switch (action.kind) {
        case "issue-session":
          void issueRef.current();
          break;
        case "prompt-consent":
          setConsent({
            gameName: game.title,
            anchorName:
              authRef.current.displayName || authRef.current.session?.name || "",
            onAllow: () => {
              grantConsent(game.slug);
              setConsent(null);
              void issueRef.current();
            },
            onDeny: () => {
              setConsent(null);
              postToFrame(buildSignedOutMessage(channelIdRef.current));
            },
          });
          break;
        case "post-signed-out":
          postToFrame(buildSignedOutMessage(channelIdRef.current));
          break;
        case "open-signin":
          onSignInRef.current();
          break;
        case "revoke":
          revokeCurrent();
          postToFrame(buildRevokedMessage(channelIdRef.current));
          break;
        case "ignore":
          break;
      }
    };

    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      revokeCurrent();
      setConsent(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, game.slug]);

  // If the platform signs out while a game is running, revoke and tell it.
  useEffect(() => {
    if (!DELEGATION_ENABLED || !running) return;
    if (!auth.signedIn && tokenRef.current) {
      revokeCurrent();
      postToFrame(buildRevokedMessage(channelIdRef.current));
    }
  }, [auth.signedIn, running, postToFrame, revokeCurrent]);

  return { consent };
}

/** Non-secret channel disambiguator. */
function randomId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
