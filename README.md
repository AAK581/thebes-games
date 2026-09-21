# thebes-games

A smart-contract project on the **Thebes** substrate, scaffolded by
`thebes-deploy new`.

## Deploy

```bash
thebes-deploy identity new default   # once per machine
thebes-deploy setup                  # checks moc / mops / cargo / npm as needed
thebes-deploy deploy                 # build + install + upload + verify
```

`thebes.toml` is the single source of truth: which network, which
canisters, how they build, who signs. The canister ids in it were
pre-allocated when this project was created, so the frontend already
knows how to reach its backend.

## Talk to the backend from the CLI

```bash
thebes-deploy query backend greet --arg '("Thebes")'
thebes-deploy call  backend increment
thebes-deploy query backend get_count
```

Arguments use Candid's textual form, same as dfx.

## Where the app is served

After `deploy`, a frontend canister's bundle is served through the
boundary at:

```
<gateway>/_/raw/<frontend-cid>/index.html
```

The exact URL (with your cid filled in) is printed at the end of every
`thebes-deploy deploy` run.

## Identity (Memphis) — only if you scaffolded with it

If this project has `frontend/public/passkey.js` (React) or
`frontend/dist/passkey.js` (no-framework), Memphis passkey sign-in is
wired up. Memphis is Thebes' identity layer — the substrate's Internet
Identity equivalent — living at canister **921**.

- A new name **registers** a passkey; an existing name **signs in**.
- The session (anchor id + token + display tag) persists in
  localStorage, so a refresh stays signed in.
- React: the `useMemphis()` hook and `<MemphisGate>` component.
  No-framework: `memphis.js` wires the buttons.

**Passkeys only work when served from the gateway.** `passkey.js` pins
the WebAuthn relying-party id to `memphis.mercaturaforum.com`, so
sign-in works at `<gateway>/_/raw/<cid>/index.html` but **fails on
localhost** (`npm run dev` can still exercise the backend). Details and
how to retarget: `passkey.PROVENANCE.md`.

The starter does **not** gate the counter on sign-in — it shows the
mechanism, not a permission model. To make it real, gate on
`auth.signedIn` in the UI **and** verify the session token in your
backend; a client-side check alone is not authorization.

## Troubleshooting

**Rust build fails with `can't find crate for 'core'` / "target may not be
installed"** — the Rust canister compiles to `wasm32-unknown-unknown`, and
the *active* toolchain lacks that target. Note the active toolchain can be
pinned by a `rust-toolchain.toml` in a parent directory (so the default
toolchain having the target is not enough). `thebes-deploy setup` reports
this. Fix, run from inside this project:

```bash
rustup target add wasm32-unknown-unknown
```

**Rust build fails mentioning some *other* workspace's members** — the
generated `backend/Cargo.toml` declares an empty `[workspace]` precisely
to stop cargo walking up into an enclosing workspace. Don't remove it.

**Motoko build fails with `moc: could not find a Qt installation`** —
your PATH's `moc` is Qt's meta-object compiler, not the Motoko
compiler (they share a name; Qt's usually sits at `/usr/bin/moc`).
`thebes-deploy setup` reports this as `wrong tool`. Fix by putting the
real compiler first on PATH — dfx users:

```bash
export PATH="$HOME/.cache/dfinity/versions/<version>/:$PATH"
```

or let mops manage it: `mops toolchain init && mops toolchain use moc`.

**`moc version does not meet the requirements of core@…`** — a mops
warning, not an error; this starter imports nothing from `mo:core`, so
the build proceeds. Align the `mops.toml` core pin with your moc
version once you start importing core modules.

**`vite build` warns `<script src="./passkey.js"> … can't be bundled
without type="module"`** (Memphis projects) — expected and harmless.
`passkey.js` is a classic script served from `public/`, so Vite copies it
verbatim. The path must stay relative because the app is served under
`/_/raw/<cid>/`; the absolute path that would silence the warning would
404 against the gateway root.

**Signed in as someone else / state from another project?** Every app on
the gateway is served from the same origin, and `localStorage` is
per-origin. This project scopes its keys by backend canister id
(`MEMPHIS_SESSION_SCOPE` in `index.html`, `thebes-demo-sender:<cid>`), so
projects no longer share a session. Note the on-chain *per-app principal*
is still derived from the origin, so two apps on the same gateway host
resolve to the same Memphis identity — that needs per-app domains, not a
client change.

**Motoko backend: keep `--legacy-persistence` in the build line.** `deploy`
upgrades in place, and an upgrade carries the canister's *stable* memory to a
fresh instance of the new module. `moc --legacy-persistence` — which your
`thebes.toml` already uses — compiles for exactly that: the `var`s in
`backend/Backend.mo` are serialised into stable memory at the upgrade hook and
read back, so they survive a code change. moc's default keeps state in *main*
memory, which needs replica-side retention this platform does not provide, and
would come back up blank. Remove the flag and `deploy --upgrade` refuses rather
than wiping you quietly. Background: `docs/MOTOKO-PERSISTENCE.md` in the Thebes
repo.

## Layout

```
thebes.toml        deploy manifest — the single source of truth
backend/           the backend canister source
frontend/          the frontend (when scaffolded with one)
  asset_canister.wasm   the asset-serving canister installed for the frontend
```
