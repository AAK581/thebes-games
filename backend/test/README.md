# Moderation end-to-end harness (local chain only)

Drives the full abuse-handling story against a throwaway local Thebes chain:
publish → 3 distinct reports → auto-quarantine (serving stops, 451) → curator
panel votes → delist + strike / restore → 3 strikes → publishing suspended →
emergency freeze → public mod_log. 58 bounded assertions, exit 0 iff all pass.

The backend resolves sessions by calling Memphis at cid 921. `MockMemphis.mo`
is planted at that cid on the LOCAL chain so a script can play any cast of
users: a token is its own anchor, its text is the display tag, tokens starting
with `bad` are rejected. **Never deploy the mock to a real network** — on WAN
cid 921 is the real Memphis and this harness has no power there.

```bash
# scratch dir, NOT the repo (keeps .thebes/local out of the tree)
mkdir -p /tmp/thebes-mod-test/{mock,build} && cd /tmp/thebes-mod-test
cp <repo>/backend/test/MockMemphis.mo mock/
cat > thebes.toml <<'EOF'
[project]
name = "thebes-mod-test"
default_network = "local"
chain_id = 31337

[networks.local]
gateway = "http://127.0.0.1:8280"
validators = []
routing = "smart"
chain_id = 31337

[canisters.mock_memphis]
type = "backend-motoko"
cid = 921
wasm = "build/mock_memphis.wasm"
build = "true"

[canisters.backend]
type = "backend-motoko"
cid = 24874376952694
wasm = "build/backend.wasm"
build = "true"
EOF

# build both wasms with the repo's mops deps
(cd <repo> && moc --legacy-persistence $(mops sources) -o /tmp/thebes-mod-test/build/backend.wasm backend/Backend.mo \
            && moc --legacy-persistence $(mops sources) -o /tmp/thebes-mod-test/build/mock_memphis.wasm /tmp/thebes-mod-test/mock/MockMemphis.mo)

# ports chosen to avoid the default 8180 (often another project's chain)
thebes-deploy start --clean --validators 2 --boundary-port 8280 --http-base 18680 --p2p-base 19680
thebes-deploy deploy --network local
NODE_PATH=<repo>/frontend/node_modules node <repo>/backend/test/drive.cjs
thebes-deploy stop
```

What it proved on 2026-10-01 (and now pins against regression):
- quarantine/emergency-freeze actually stop `http_request` serving (451), not
  just the shelf card — including covers, shots, and the streaming callback;
- reports die with a listing (delist/unpublish), so a freed slug's next
  publisher does not inherit accusers or get insta-quarantined;
- one active case per game: no second freeze-case, and a stale case can never
  flip a listing a newer case governs;
- 3 strikes suspend publishing; every action lands on the public mod_log.
