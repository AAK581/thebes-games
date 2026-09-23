# Memphis Delegated Sessions — signing in *inside* an embedded game

**Status:** design approved 2026-09-23 (§11). **Implemented** on both branches —
`thebes-games@feat/embedded-signin` (frontend, dormant behind
`window.THEBES_DELEGATION`) and `Thebes-Project@feat/memphis-delegated-sessions`
(Memphis canister + `MemphisAuth.mo`; `cargo test -p memphis` green, wasm builds).
**Not deployed.** Mainnet Memphis (921) deploy gated on Kareem's approval — test
network first.
**Author:** Thebes Games
**Scope:** frontend (`thebes-games`) + chain (`Thebes-Project`, Memphis canister 921)
**Supersedes nothing.** The `standalone ↗` fallback stays until this ships and is proven.

---

## 1. The problem, precisely

A user playing a game in the embedded player clicks the game's own **Sign in**
and it fails. Two independent reasons, established by reading the substrate — not
assumed:

1. **WebAuthn refuses the frame.** The player sandboxes each game with an
   **opaque origin** (`<iframe sandbox="allow-scripts …">`, deliberately *no*
   `allow-same-origin` — see `components.tsx`, "SECURITY INVARIANT"). WebAuthn
   (`navigator.credentials`) rejects an opaque origin outright, and `passkey.js`
   pins its relying-party id to `memphis.mercaturaforum.com`, which a `null`
   origin can never match. So a game can *never* run the passkey ceremony itself
   inside the player.

2. **Sharing the platform session would be a wallet-drainer.** Every app on the
   Thebes gateway is served from **one origin** (`<gateway>/_/raw/<cid>/…`), so
   `localStorage` — where the Memphis session lives — is shared across *all*
   apps. The sandbox omits `allow-same-origin` exactly so a game cannot read
   `window.parent.localStorage` and walk off with your Memphis session token for
   every app you've ever signed into. That door must stay shut.

So "just let the game sign in" is not an option, and "just give the game the
session" is the exact attack the sandbox exists to prevent.

### Why it can't be fixed on the frontend alone

The Memphis session token (verified against `passkey.js` and the canister-reply
decoders it carries) is an **anchor-level bearer blob**:

```
MemphisSession = { name, anchor_id_hex, session_token_hex, expires_at_ns, display_tag }
```

`register`/`authenticate` on canister 921 mint `session_token` (a `blob`) with an
expiry; a `whoami`-style verify resolves *any holder* of that blob to the anchor,
and the same blob authorizes `claim_name`, `end_session`, and factor management.
**One token, total account power, no audience field.** There is no "valid only
for game X" concept to hand out. Any frontend-only scheme therefore either hands
over the real token (unsafe) or hands over something a game's backend cannot
verify (useless).

**Conclusion:** safe in-window sign-in requires a *new, scoped* credential that
Memphis mints and verifies. That is the chain change this document specifies.

---

## 2. The idea in one paragraph

The **platform** (top-level document, correct origin, where passkeys already
work) is the only party that holds the real session token. When a signed-in user
plays a game, the platform asks Memphis to mint a **delegated session** — a
*different* bearer token bound to a single **audience** (that game's backend) and
a short TTL — and hands *that* to the game over a `postMessage` handshake. The
game uses it as its session; the game's backend verifies it against Memphis,
which returns the anchor **only** to the matching audience. A leaked or malicious
game token is then worth exactly one thing: acting as the user against the game
it was already playing — never the platform session, never another app, never
Memphis account operations. Delegation collapses the blast radius from "every app
+ account takeover" to "the one game you chose."

This is the Internet Identity delegation model (scoped, expiring delegations)
adapted to Memphis's bearer-token world.

---

## 3. Threat model

**Assets (most to least sensitive)**
1. The anchor-level `session_token` — full account control at Memphis.
2. The user's authority at *other* apps' backends on the gateway.
3. The user's authority at *this* game's backend.

**Adversaries**
- **A malicious or compromised game** (its frontend bytes, its backend, or both).
  A game's backend is fully controlled by its publisher already, so "the game
  acts as the user against its own backend" is not a new power — it is the
  *intended* one.
- **A hostile page on the gateway** trying to phish a delegation.
- **A network/relay observer** (the boundary/validators).

**Guarantees the design must provide**
- **G1** The real `session_token` never leaves the top-level platform document.
  It is never placed in a `postMessage`, never in the frame, never in a game
  backend call.
- **G2** A delegated token is **useless for anchor-level operations** at Memphis
  (`claim_name`, `end_session`, minting further delegations, factor management).
- **G3** A delegated token is **useless against any audience but its own** — no
  cross-game replay, even between two games the user has open.
- **G4** Delegations are **short-lived** and **revocable**, and revoking the
  parent session cascades to all its delegations.
- **G5** The platform, not the game, chooses the audience. A game cannot widen
  its own scope by lying in the handshake.
- **G6** Only a party that holds the real session (the platform) can mint a
  delegation; a hostile gateway page cannot.

---

## 4. Chain changes — Memphis canister 921 (`Thebes-Project` branch) — IMPLEMENTED

Branch `feat/memphis-delegated-sessions`. Built and tested (`cargo test -p
memphis`: 58 pass incl. 8 new gates; wasm builds). **Not deployed** — mainnet 921
awaits Kareem's approval; test-net first.

> **Design note — how the real substrate reshaped this.** Reading the canister
> settled two things the earlier draft got wrong. (1) **Memphis never reads
> `msg.caller`** — every call is authenticated by a token passed as an *argument*
> (`claim_name` even takes the app `origin` as text for this reason), and Thebes
> canister ids are `u64`, not principals. So audience can't be a caller check.
> (2) Sessions live in an in-memory `HashMap` snapshotted on upgrade, not
> stable-structures. The design below is what actually shipped.

### 4.1 New state

A second in-memory map, disjoint from `SESSIONS`, snapshotted on upgrade exactly
like the existing maps:

```rust
struct DelegatedSessionRecord {
    anchor_id:     [u8; 32],
    audience:      String,   // the game backend cid (decimal) the token is for
    parent_token:  [u8; 32], // the anchor session it descends from — for cascade
    expires_at_ns: u64,      // min(now+ttl, now+15min, parent.expires)
    epoch_at_mint: u64,      // parent anchor's sign-out-everywhere epoch
}
static DELEGATED_SESSIONS: RefCell<HashMap<[u8;32], DelegatedSessionRecord>>;
```

Upgrade-safe: added to `StableMemphisV1` as an `#[serde(default)] Option<Vec<…>>`
(the codebase's proven post-V1 pattern — an old snapshot lacking the field
decodes to empty). Verified by the existing forward-compat tests + a new
round-trip gate.

### 4.2 New methods

```candid
// Mint a delegated token from a live ANCHOR session_token (arg #1 — the token
// IS the authorization, no caller check), scoped to `audience` for `ttl_ns`.
open_delegated_session : (blob, text, nat64)
    -> (variant { Ok : DelegatedSessionResult; Err : MemphisError });

// Resolve a delegated token to its anchor — ONLY for the matching audience.
// The GAME BACKEND passes its OWN cid as `audience`; Memphis compares it to the
// token's stored audience on-canister (the OAuth `aud` check) and returns
// Err(Unauthorized) on mismatch. `query` (runs replicated cross-canister, like
// whoami); `verify_delegated_u` is the update-callable twin.
verify_delegated   : (blob, text) -> (variant { Ok : WhoAmIResult; Err : MemphisError }) query;
verify_delegated_u : (blob, text) -> (variant { Ok : WhoAmIResult; Err : MemphisError });

// Idempotent explicit revoke (platform calls on stop / sign-out).
revoke_delegated_session : (blob) -> (variant { Ok; Err : MemphisError });
```

`verify_delegated` returns a `WhoAmIResult` (the same shape `whoami` returns) so
the existing `SessionGate → derive_principal_for` flow is **unchanged** — a game
backend swaps `whoami(token)` for `verify_delegated(token, my_cid)` and nothing
else moves.

**Errors reuse existing `MemphisError` variants** (`NotAuthenticated` /
`SessionExpired` / `Unauthorized`) — adding variants would break every existing
decoder of `whoami`/`claim_name` errors. No Candid-interface break.

### 4.3 Enforcement rules (the security core, as implemented)

- **G2 is automatic, not a guarded branch.** Delegated tokens live in a *separate
  map* from `SESSIONS`. `open_delegated_session`, `claim_name`, and `end_session`
  all look a token up in `SESSIONS`; a delegated token isn't there, so it resolves
  to `NotAuthenticated`. No edits to those functions — the map disjointness (a
  distinct hash domain guarantees no collision) enforces it. Delegation-of-a-
  delegation therefore can't happen either.
- **G3 audience binding.** `verify_delegated(token, audience)` returns
  `Err(Unauthorized)` unless `record.audience == audience`. The backend passes its
  *own* cid, so a token minted for game A fails at game B (B passes B's cid).
- **G4 lifetime.** `expires = min(now + ttl, now + 15min, parent.expires)`;
  `verify_delegated` rejects past-expiry (`SessionExpired`). `end_session(parent)`
  drops every delegation whose `parent_token` matches (cascade). A
  sign-out-everywhere epoch bump invalidates delegations via the `epoch_at_mint`
  check, exactly as it does anchor sessions.
- **G6 minting authority.** `open_delegated_session` requires a live anchor
  session token — which only the platform holds.

### 4.4 Reusable game-backend verifier — shipped in `MemphisAuth.mo`

Not a snippet: `verifyDelegated(gate, token, audience)` was added to the standard
`MemphisAuth.mo` next to `verify`. A game's backend calls it with its own cid; it
resolves the anchor (only for that audience) and derives the same stable per-app
principal as a normal sign-in, so game state is identical whether the user signed
in standalone or in-window:

```motoko
// In the game's own canister; `gate` built with MemphisAuth.initFromCid(921, …).
switch (await MemphisAuth.verifyDelegated(gate, delegToken, MY_BACKEND_CID)) {
  case (#ok(id))  { /* id.principal — the verified per-app user */ };
  case (#err(e))  { /* #Memphis(#Unauthorized) = token wasn't minted for us */ };
};
```

---

## 5. Frontend changes — `thebes-games`

Target branch: `feat/embedded-signin` (frontend-only; safe to run against the
live gateway once the Memphis branch is deployed to test).

### 5.1 New/changed files

| file | change |
|---|---|
| `frontend/src/memphisDelegation.ts` | **new.** Wraps the two new Memphis calls via `window.MemphisPasskey._memphisCallAwait` (already exposed — no passkey.js fork). `openDelegatedSession(realTokenHex, audiencePrincipal, ttlNs)` and `revokeDelegation(tokenHex)`. |
| `frontend/public/thebes-games-sdk.js` | **new.** The tiny receiver a game embeds (see §6.2). Vendored/served so games can `<script src>` it or copy it. |
| `frontend/src/components.tsx` (`PlayerShell`) | issue+post the delegation on game boot; handle the handshake; revoke on stop/unmount. |
| `frontend/src/pages/Game.tsx` / `data.ts` | add `backendCid` to the `Game` record (the audience). Until the registry lands, fill it per game in `data.ts`; the registry becomes the source of truth later. |
| consent UI | a small platform-rendered dialog: "Play **Basra** as **yourname.thebes**?" — remembered per game. Rendered top-level (never in the frame). |

### 5.2 Handshake placement

The platform already builds the game document (`wrapGameHtml`) and controls the
iframe. It learns the frame is ready when the SDK posts `hello`, validates the
message came from *its* iframe, and (if signed in + consented) mints and posts the
delegation.

---

## 6. The wire protocol

### 6.1 Channel authentication (both directions)

Because the frame is opaque-origin, `postMessage` must use `targetOrigin: "*"`
and the receiver **cannot** rely on `event.origin` (it is `"null"`). Authenticate
the channel structurally instead:

- **Parent → frame:** only ever post to `iframe.contentWindow`. Never broadcast.
- **Frame → parent:** parent **must** check `event.source === iframe.contentWindow`
  and ignore everything else.
- **Replay/nested-frame guard:** the parent generates a random `channelId` per
  boot, sends it in the first message, and requires it echoed on every subsequent
  message. The SDK likewise pins the first `channelId` it sees and rejects
  mismatches (defends against a nested iframe the game itself loads).

`channelId` is not a secret and not an authorizer — it only disambiguates
windows. The real authorizer is `event.source` identity + the fact that the
*only* sensitive payload (the deleg token) is sent parent→frame to a specific
`contentWindow`.

### 6.2 Messages

```ts
// frame → parent
{ v: 1, type: "memphis:hello", channelHint?: string }         // SDK boot ping
{ v: 1, type: "memphis:request-signin", channelId: string }   // user clicked "Sign in on Thebes"
{ v: 1, type: "memphis:signout",       channelId: string }    // game asked to drop the session

// parent → frame
{ v: 1, type: "memphis:session", channelId: string,
  token: string /* DELEGATED token hex — never the real one */,
  anchor: { display_tag: string, name?: string }, expires_at_ns: string }
{ v: 1, type: "memphis:signed-out", channelId: string }       // not signed in / declined
{ v: 1, type: "memphis:revoked",    channelId: string }       // platform revoked (sign-out/stop)
```

The SDK exposes to the game:

```ts
window.ThebesGames = {
  onSession(cb: (s: { token: string; anchor: {display_tag:string; name?:string};
                      expiresAtNs: string } | null) => void): void,
  requestSignIn(): void,
  signOut(): void,
};
```

A game calls `ThebesGames.onSession(...)`; when it receives a session it attaches
`token` to its backend update calls (as the `deleg_token` argument, §4.4). When it
receives `null` it shows a "Sign in on Thebes" button wired to `requestSignIn()`.

### 6.3 Sequence

```
game boots ──hello──▶ platform
                       │  validate event.source === iframe.contentWindow
                       │  signed in?  ──no──▶ post signed-out ; game shows "Sign in on Thebes"
                       │                         └─ user clicks ─request-signin▶ platform
                       │                            opens ITS OWN top-level MemphisGate (passkey OK here)
                       │  signed in + consented?
                       ▼
        open_delegated_session(realToken, game.backendCid, ttl)  [Memphis]
                       │  Ok{ deleg_token, expires }
                       ▼
             post memphis:session{ token: deleg_token, … } ──▶ game
                                                              game calls its backend with deleg_token
                                                              backend verify_delegated ⇒ anchor ✓
 user hits Stop / signs out ─▶ platform posts revoked + Memphis revoke_delegation / end_session cascade
```

**The platform passes `game.backendCid` from the trusted catalogue as the
audience — never a value the frame supplied.** (G5.)

---

## 7. Security analysis (attack → mitigation)

| # | Attack | Mitigation | Guarantee |
|---|---|---|---|
| 1 | Game reads platform session from shared `localStorage` | opaque origin (no `allow-same-origin`); platform only ever posts a *delegated* token | G1 |
| 2 | Game uses its token for Memphis account ops (`claim_name`, `end_session`) | anchor verifier rejects delegated tokens (`NotAnAnchorSession`) | G2 |
| 3 | Game A replays its token to game B's backend (or B is malicious and forwards it) | `verify_delegated` requires `msg.caller == audience`; B-as-caller ≠ A-audience ⇒ reject | G3 |
| 4 | Game hoards the token for later | short `MAX_DELEG_TTL`; expiry clamped ≤ parent; revoke on stop | G4 |
| 5 | User signs out on platform but game keeps acting | `end_session` cascade deletes children; platform also posts `revoked` | G4 |
| 6 | Game lies in `hello` to widen its audience | audience is `game.backendCid` from the catalogue, not from the message | G5 |
| 7 | Hostile gateway page mints a delegation | `open_delegated_session` requires a valid anchor session token, which only the platform holds | G6 |
| 8 | Nested iframe inside the game injects/reads messages | parent checks `event.source`; both sides pin `channelId`; sensitive payload posted only to the top game frame's `contentWindow` | G1/G3 |
| 9 | Relay/boundary observes the delegated token | token is audience+TTL-scoped; observation buys only what a malicious game already has (attack #3/#4 bounds it) | G3/G4 |
| 10 | Token exfiltrated to a totally different origin/app | still only resolves for its audience canister; worthless elsewhere | G3 |

Residual, accepted risk: a malicious game can act as the signed-in user **against
its own backend** for up to one TTL. That is inherent to letting a game act on
your behalf at all, and is identical to the authority the game's publisher already
has over its own canister. Consent (§5.1) makes it explicit and per-game.

---

## 8. What this does *not* do

- It does **not** give the game your platform session, another app's session, or
  Memphis account control (by construction).
- It does **not** enable WebAuthn inside the frame (still impossible); the passkey
  ceremony always happens top-level on the platform.
- It does **not** fix the shared-origin *per-app principal* collision for apps
  that authenticate the old (origin-derived) way — but games that adopt this SDK
  key off the **anchor + audience**, side-stepping that collision entirely. The
  eventual per-app-domains work remains the general fix and is orthogonal.

---

## 9. Verification plan (bounded, falsifiable — no "looks fine")

**Chain (Memphis) unit tests — implemented in `lib.rs`, all passing
(`cargo test -p memphis`):**
- **T1 happy path** (`deleg_t1`): mint → `verify_delegated_at(tok, audience)`
  returns the parent's `anchor_id`. ✅
- **T2 anchor-op refusal / G2** (`deleg_t2`): a delegated token via `whoami_at`
  → `NotAuthenticated`, and as a parent to `open_delegated_at` → `NotAuthenticated`
  (no chaining). Enforced by map disjointness. ✅
- **T3 audience isolation / G3** (`deleg_t3`): wrong audience → `Unauthorized`;
  correct audience → `Ok`. ✅
- **T4 ttl clamp + expiry / G4** (`deleg_t4`): absurd ttl clamps to 15 min; a near
  parent expiry clamps below it; past-expiry → `SessionExpired`. ✅
- **T5 end_session cascade / G4** (`deleg_t5`): `end_session(parent)` ⇒ child →
  `NotAuthenticated`. ✅
- **T6 sign-out-everywhere / G4** (`deleg_t6`): anchor epoch bump ⇒ child →
  `SessionExpired`. ✅
- **T7 upgrade safety** (`deleg_t7`): `build_snapshot` → clear → `restore_snapshot`
  ⇒ delegation still resolves. (Plus the pre-existing forward-compat suite passes
  unchanged.) ✅
- **T8 explicit revoke** (`deleg_t8`): `revoke_delegated_session` removes exactly
  the token, idempotently. ✅

**Frontend tests:**
- **T7 no-leak (G1):** capture every `postMessage` the platform emits during a
  full play+signout cycle; assert **none** contains `session.session_token_hex`.
  This is the hard, external check that the real token never ships.
- **T8 source check:** a message from a window that is *not* the game iframe is
  ignored (unit test on the handler).
- **T9 audience binding (G5):** a `hello` carrying a forged `backendCid` does not
  change the audience passed to `open_delegated_session` (spy asserts it equals
  `game.backendCid` from the catalogue).

**Integration (against test Memphis + a throwaway game backend):**
- **T10 end-to-end:** platform issues delegation → SDK calls the test backend's
  `whoami_echo(deleg_token)` → asserts it echoes the signed-in anchor; then the
  *other* game's token is rejected by the same backend (live G3).

No item is "verified" by inspection; each has a threshold committed before the
run. Critical items (T2, T3, T7) are the release gates.

---

## 10. Rollout

1. Land Memphis methods on `feat/memphis-delegated-sessions`; deploy to **test**
   Memphis; run T1–T6. **No mainnet Memphis deploy without Kareem's approval.**
2. Land frontend on `feat/embedded-signin` behind a flag
   (`window.THEBES_DELEGATION = true` / a data.ts toggle). SDK served but dormant.
3. Wire **one** game end-to-end (Basra) against test Memphis; run T7–T10.
4. Flip the flag for adopting games; `standalone ↗` remains for the rest.
   Games without the SDK are unaffected — they simply never receive a session.

Backwards compatible throughout: new Memphis methods + new stable maps only;
non-adopting games and the current player keep working unchanged.

---

## 11. Decisions (approved 2026-09-23)

1. **Audience = game *backend* canister id.** ✅ Each catalogue entry declares
   `backendCid` (hand-filled in `data.ts` until the registry serves it);
   `verify_delegated` enforces `msg.caller == audience`.
2. **`MAX_DELEG_TTL` = 15 minutes**, with silent re-issue while the game stays
   open. ✅
3. **Consent UX = per-game, remembered until sign-out.** ✅ ("Play <game> as
   <name>?", rendered top-level, one dialog per game.)
4. **No delegation-of-a-delegation in v1.** ✅ (`open_delegated_session` rejects a
   delegated token as its `session_token` input.)
5. **Repo split:** chain → `Thebes-Project@feat/memphis-delegated-sessions`
   (reusable game-backend verifier ships here, next to the canister it calls);
   frontend + SDK → `thebes-games@feat/embedded-signin`. ✅

**Still gated:** deploying the Memphis methods to **mainnet** canister 921 needs
Kareem's explicit approval. Test-network deploy + T1–T6 first.

---

## 12. Work split summary

**`Thebes-Project` (chain, needs approval to deploy):**
- Memphis: `open_delegated_session`, `verify_delegated`, `revoke_delegation`,
  delegated-token tagging in the anchor verifier, `end_session` cascade, two new
  stable maps.
- Tests T1–T6; reusable backend verifier snippet.

**`thebes-games` (frontend, no chain risk):**
- `memphisDelegation.ts` (calls via exposed `_memphisCallAwait`).
- `thebes-games-sdk.js` (the game-side receiver).
- `PlayerShell` handshake + consent UI + revoke-on-stop.
- `Game`/`data.ts` `backendCid` field.
- Tests T7–T10; keep `standalone ↗`.
