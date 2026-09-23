/**
 * thebes-games-sdk.js — the game-side half of Memphis Delegated Sessions
 * (docs/memphis-delegated-sessions.md). A game running inside the Thebes
 * Games player embeds this to sign in as the platform user WITHOUT running
 * WebAuthn (impossible in the opaque-origin sandbox) and without ever
 * touching the platform's real session token.
 *
 * Usage in a game (classic script, no build step required):
 *
 *   <script src="/thebes-games-sdk.js"></script>
 *   <script>
 *     ThebesGames.onSession(function (s) {
 *       if (s) {
 *         // s.token  -> delegated token; send it as the `deleg_token` arg
 *         //             on your backend update calls. Your canister verifies
 *         //             it via Memphis `verify_delegated` (see the spec).
 *         // s.anchor -> { display_tag, name } for greeting the user.
 *         showSignedIn(s.anchor);
 *       } else {
 *         showSignInButton(); // wire it to ThebesGames.requestSignIn()
 *       }
 *     });
 *   </script>
 *
 * Security notes for game authors:
 *  - The token you receive is scoped to YOUR backend and expires quickly;
 *    it is refreshed automatically while you're open. Never persist it.
 *  - You will only ever receive a delegated token here, never the user's
 *    platform session. That is by design.
 *  - Outside the Thebes player (opened standalone) no parent responds, so
 *    `onSession` fires with null and you fall back to your own sign-in.
 */
(function (global) {
  "use strict";

  var PROTOCOL_VERSION = 1;
  var parentWin = global.parent && global.parent !== global ? global.parent : null;

  var channelId = null; // pinned from the parent's first addressed message
  var current = null; // latest session payload (or null when signed out)
  var listeners = [];
  var delivered = false; // have we called back at least once?

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](current);
      } catch (e) {
        /* a listener throwing must not break the SDK */
      }
    }
  }

  function post(msg) {
    if (!parentWin) return;
    // Parent frame is opaque-origin from our side too; "*" is required.
    parentWin.postMessage(msg, "*");
  }

  function onMessage(event) {
    // Trust only messages from our actual parent window.
    if (!parentWin || event.source !== parentWin) return;
    var m = event.data;
    if (!m || typeof m !== "object" || m.v !== PROTOCOL_VERSION) return;
    if (typeof m.type !== "string") return;

    // Pin the channel id from the first addressed message; reject any later
    // message bearing a different id (defends against a nested frame).
    if (m.channelId) {
      if (channelId === null) channelId = m.channelId;
      else if (m.channelId !== channelId) return;
    }

    switch (m.type) {
      case "memphis:session":
        if (typeof m.token !== "string") return;
        current = {
          token: m.token,
          anchor:
            m.anchor && typeof m.anchor === "object"
              ? { display_tag: m.anchor.display_tag, name: m.anchor.name }
              : { display_tag: "" },
          expiresAtNs: typeof m.expires_at_ns === "string" ? m.expires_at_ns : "0",
        };
        delivered = true;
        notify();
        break;
      case "memphis:signed-out":
      case "memphis:revoked":
        current = null;
        delivered = true;
        notify();
        break;
      default:
        break;
    }
  }

  if (parentWin) {
    global.addEventListener("message", onMessage);
    // Announce readiness; the platform replies with signed-out/session.
    post({ v: PROTOCOL_VERSION, type: "memphis:hello" });
  }

  global.ThebesGames = {
    /**
     * Register a session callback. Fires with the current session (or null)
     * immediately if one is already known, and again on every change.
     */
    onSession: function (cb) {
      if (typeof cb !== "function") return function () {};
      listeners.push(cb);
      if (delivered) {
        try {
          cb(current);
        } catch (e) {
          /* ignore */
        }
      }
      // If there's no parent at all (opened standalone), there will never be
      // a session — tell the game once so it can show its own sign-in.
      if (!parentWin && !delivered) {
        delivered = true;
        try {
          cb(null);
        } catch (e) {
          /* ignore */
        }
      }
      return function unsubscribe() {
        var i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    /** Ask the platform to sign in (opens its top-level passkey flow). */
    requestSignIn: function () {
      if (!parentWin) return;
      post({
        v: PROTOCOL_VERSION,
        type: "memphis:request-signin",
        channelId: channelId || "",
      });
    },

    /** Ask the platform to drop this game's delegated session. */
    signOut: function () {
      if (!parentWin) return;
      post({
        v: PROTOCOL_VERSION,
        type: "memphis:signout",
        channelId: channelId || "",
      });
    },

    /** Current session snapshot (or null), for imperative reads. */
    getSession: function () {
      return current;
    },

    protocolVersion: PROTOCOL_VERSION,
  };
})(typeof window !== "undefined" ? window : this);
