// thebes-games backend — registry + vault for user-published games.
//
// This canister is BOTH:
//   • the REGISTRY — the on-chain catalogue of games (metadata + owner
//     anchor + where the bytes live), the source of truth the frontend reads
//     instead of a static file; and
//   • the VAULT — it stores each uploaded game's files and SERVES them over
//     `http_request`, so a game plays at
//         <gateway>/_/raw/<this-cid>/g/<slug>/index.html
//     A game's relative assets resolve because the player injects an absolute
//     <base href> for that subpath (see frontend PlayerShell).
//
// Publishing is gated by a Memphis session token (verified inter-canister
// against Memphis cid 921), so every game is owned by the publisher's anchor.
//
// Two "source" kinds:
//   • #vault  — files stored here, served by this canister (the upload path);
//   • #canister — an externally-deployed game canister, referenced by cid
//     (how the three seed games work — the platform doesn't host their bytes).
//
// Upgrades keep state: `persistent actor` + `--legacy-persistence` (thebes.toml).

import Map "mo:core/Map";
import Set "mo:core/Set";
import List "mo:core/List";
import Text "mo:core/Text";
import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Nat16 "mo:core/Nat16";
import Array "mo:core/Array";
import Iter "mo:core/Iter";
import Int "mo:core/Int";
import Char "mo:core/Char";
import Time "mo:core/Time";
import Principal "mo:core/Principal";
import Region "mo:core/Region";

persistent actor Backend {

  // ─── Wire types ────────────────────────────────────────────────────────

  type Rating = { #E; #T; #M };
  type Source = { #vault; #canister : Text };
  type Status = { #live; #quarantined : { caseId : Nat } };

  // Metadata a publisher supplies at begin_publish.
  type GameMeta = {
    title : Text;
    tagline : Text;
    description : Text;
    tags : [Text];
    rating : Rating;
    // The game's native render resolution in px (e.g. RPG Maker MZ is 816×624).
    // Optional so a mid-deploy old caller still decodes; defaults applied below.
    resW : ?Nat;
    resH : ?Nat;
  };

  // The public catalogue view — no owner-internal fields beyond the handle.
  type GameView = {
    slug : Text;
    title : Text;
    tagline : Text;
    description : Text;
    tags : [Text];
    rating : Rating;
    owner : Text; // display: the publisher's name or short anchor tag
    source : Source;
    sizeBytes : Nat;
    updatedAtNs : Nat64;
    status : Status;
    plays : Nat;
    favorites : Nat;
    cover : Bool; // true when the creator uploaded a cover image
    shots : Nat; // how many screenshots, served at /g/<slug>/__shot/<i>
    resW : Nat; // native resolution the player frames the game at (fills, no letterbox)
    resH : Nat;
  };

  // The stored record.
  type Game = {
    slug : Text;
    title : Text;
    tagline : Text;
    description : Text;
    tags : [Text];
    rating : Rating;
    ownerAnchor : Blob; // Memphis anchor_id — the owner
    ownerName : Text; // display tag / name at publish time
    source : Source;
    var sizeBytes : Nat;
    var status : Status;
    createdAtNs : Nat64;
    var updatedAtNs : Nat64;
    var finished : Bool; // false while an upload is in flight
  };
  // plays live in a SEPARATE map (playCounts), not a Game field — adding a
  // field to a record already in stable memory is an incompatible upgrade
  // (M0170); a new top-level stable var is always safe.

  type FileRef = { offset : Nat64; length : Nat };
  type Cover = { ct : Text; offset : Nat64; length : Nat };
  // A screenshot — same shape as a cover, stored in the same region. Kept in
  // an ordered list per game so the gallery has a stable, creator-chosen order.
  type Shot = { ct : Text; offset : Nat64; length : Nat };

  // ─── Moderation ────────────────────────────────────────────────────────
  type Verdict = { #restore; #delist };
  type CaseKind = { #reports; #emergency };
  type ModCase = {
    id : Nat;
    slug : Text;
    kind : CaseKind;
    openedAtNs : Nat64;
    // curator anchor → their vote (last one wins)
    votes : Map.Map<Blob, Verdict>;
    var resolved : ?Verdict;
  };
  type LogEntry = {
    atNs : Nat64;
    action : Text; // report | quarantine | emergency-freeze | vote | restore | delist | strike
    target : Text; // slug
    who : Text; // display name of who acted (`actor` is a reserved word)
    detail : Text;
    caseId : Nat; // 0 when not tied to a case
  };
  type CaseView = {
    id : Nat;
    slug : Text;
    kind : Text;
    openedAtNs : Nat64;
    restoreVotes : Nat;
    delistVotes : Nat;
    resolved : ?Text;
  };

  // ─── Memphis auth (verify a session token → anchor) ────────────────────

  type MemphisError = {
    #NotAuthenticated;
    #Unauthorized;
    #SessionExpired;
    #ChallengeExpired;
    #AnchorNotFound;
    #FactorNotFound;
    #InsufficientFactors;
    #DuplicateCredential;
    #InvalidArgument : Text;
    #InvariantViolation : { id : Text; details : Text };
  };
  type WhoAmIResult = {
    anchor_id : Blob;
    session_expires_ns : Nat64;
    display_tag : Text;
  };

  // The Thebes substrate addresses canisters by numeric id; a callee principal
  // is exactly the 8 big-endian bytes of that id (see MemphisAuth.mo).
  func principalOfCid(cid : Nat64) : Principal {
    let bytes = Array.tabulate<Nat8>(
      8,
      func(i) {
        Nat8.fromNat(Nat64.toNat((cid >> (Nat64.fromNat((7 - i) * 8))) & 0xff));
      },
    );
    Principal.fromBlob(Blob.fromArray(bytes));
  };

  transient let Memphis = actor (Principal.toText(principalOfCid(921))) : actor {
    // Update-callable whoami: inter-canister replies flow through the update
    // path (the query export doesn't deliver inter-canister replies yet).
    whoami_u : (Blob) -> async ({ #Ok : WhoAmIResult; #Err : MemphisError });
  };

  // token → (anchor, name, expiry). Caches a verify so a multi-chunk upload
  // does not hit Memphis on every chunk (the MemphisAuth cache pattern).
  type Session = { anchor : Blob; name : Text; expiresNs : Nat64 };
  let sessions = Map.empty<Blob, Session>();

  // Resolve a session token to its anchor, cached. null = not signed in.
  // async* — a directly-awaited private helper (saves a self-message).
  func authed(token : Blob) : async* ?Session {
    let nowNs = Nat64.fromNat(Int.abs(Time.now()));
    switch (Map.get(sessions, Blob.compare, token)) {
      case (?s) { if (s.expiresNs > nowNs) return ?s };
      case null {};
    };
    switch (await Memphis.whoami_u(token)) {
      case (#Ok w) {
        let s : Session = {
          anchor = w.anchor_id;
          name = w.display_tag;
          expiresNs = w.session_expires_ns;
        };
        Map.add(sessions, Blob.compare, token, s);
        ?s;
      };
      case (#Err _) { null };
    };
  };

  // ─── State ─────────────────────────────────────────────────────────────

  let vaultRegion : Region.Region = Region.new();
  var vaultTop : Nat64 = 0;
  let games = Map.empty<Text, Game>();
  let fileStore = Map.empty<Text, Map.Map<Text, FileRef>>();
  // slug → (path → chunks in order), for uploads in flight.
  // TRANSIENT on purpose: an in-flight upload is ephemeral (it lives only
  // between begin_publish and finish_publish). Persisting it is pointless (a
  // half-uploaded game can't resume across an upgrade) and harmful — a
  // failed/abandoned upload's multi-MB chunks would otherwise survive in
  // stable state and, once the total tops ~10 MB, brick every future upgrade
  // (post_upgrade re-reads all stable vars in one allocation; the substrate
  // caps a single allocation at 10 MiB). An upgrade mid-upload loses that one
  // in-flight upload; the publisher re-uploads.
  transient let pending = Map.empty<Text, Map.Map<Text, List.List<Blob>>>();
  // slug → cover chunks in flight (transient, same rationale as `pending`): a
  // cover is uploaded in chunks so no single call body exceeds the node's inline
  // ingress ceiling (a whole-image set_cover call 413s past ~256 KB), then
  // cover_commit assembles it into the region.
  transient let pendingCover = Map.empty<Text, List.List<Blob>>();
  // slug → screenshot chunks in flight (transient, same rationale as `pending`).
  transient let pendingShot = Map.empty<Text, List.List<Blob>>();
  // slug → set of anchors that favorited it
  let favorites = Map.empty<Text, Set.Set<Blob>>();
  // slug → cover image (served at /g/<slug>/__cover)
  let coverStore = Map.empty<Text, Cover>();
  // slug → ordered screenshots (served at /g/<slug>/__shot/<i>). A separate
  // top-level stable var, like every other post-launch addition.
  let shotStore = Map.empty<Text, List.List<Shot>>();
  // slug → the game's native resolution (px). The player frames the game at
  // exactly this so it fills the stage instead of letterboxing. A separate map,
  // not a Game field — a new top-level stable var is upgrade-safe (plays note).
  let gameRes = Map.empty<Text, { w : Nat; h : Nat }>();
  // slug → play count (kept out of the Game record for upgrade safety)
  let playCounts = Map.empty<Text, Nat>();

  // Moderation state.
  var platformOwner : ?Blob = null; // set once via claim_owner (trust-on-first-use)
  let curators = Set.empty<Blob>(); // curator anchors (the owner is one)
  let reports = Map.empty<Text, Set.Set<Blob>>(); // slug → distinct reporter anchors
  var caseSeq : Nat = 0;
  let cases = Map.empty<Nat, ModCase>();
  let strikes = Map.empty<Blob, Nat>(); // anchor → strike count
  let modLog = List.empty<LogEntry>();

  transient let QUARANTINE_THRESHOLD : Nat = 3; // distinct reporters → auto-quarantine
  transient let PANEL_MAJORITY : Nat = 2; // curator votes to resolve a case
  transient let SUSPEND_STRIKES : Nat = 3; // publishing blocked at this many strikes

  // Limits (MVP; documented, not stubs).
  // 256 MB / game: heap-bound (all vault bytes live in the canister's heap
  // during operation), so at scale the vault shards into multiple canisters.
  transient let MAX_GAME_BYTES : Nat = 256 * 1024 * 1024;
  // Game files are served via the streaming-callback path (http_request +
  // http_request_streaming_callback), so a single file is bounded only by the
  // per-game total — no per-file serving ceiling. Covers are served inline in
  // one response, so they keep a small cap.
  // A cover is served inline in one http_request response, so it must fit the
  // node's single-response body limit — the same ~1.9 MB bound the streamed
  // file path chunks at.
  transient let MAX_COVER_BYTES : Nat = 1_900_000;
  transient let MAX_COVER_CHUNKS : Nat = 128; // bounds in-flight cover memory
  // Screenshots. Each is served inline in ONE response like a cover, so it
  // carries the same per-image ceiling; the count cap is what bounds a game's
  // total gallery (6 × 1.9 MB worst case) and keeps the page honest — a shelf
  // listing is not an image host.
  transient let MAX_SHOTS : Nat = 6;
  transient let MAX_SHOT_BYTES : Nat = 1_900_000;
  transient let MAX_SHOT_CHUNKS : Nat = 128;
  transient let SERVE_CHUNK : Nat = 1_900_000; // bytes per streamed response chunk
  transient let MAX_FILES : Nat = 4096;
  transient let MAX_CHUNK_BYTES : Nat = 64 * 1024; // one put_chunk
  // Native-resolution bounds (px). Default is RPG Maker MZ's 816×624; the max
  // bounds the game canvas so a publisher can't demand an unbounded viewport.
  transient let DEFAULT_RES_W : Nat = 816;
  transient let DEFAULT_RES_H : Nat = 624;
  transient let MIN_RES_DIM : Nat = 200;
  transient let MAX_RES_DIM : Nat = 2560;

  // Bump on every deploy. Two jobs: (1) "which build is live?" is a plain
  // query instead of guesswork; (2) the tag changes the module bytes, so each
  // tagged build gets a fresh wasm sha256 and therefore a fresh chunked-install
  // upload_id — without it, a retry after a failed install resumes the SAME
  // upload on the SAME validator (the id is derived from the hash), which
  // pins the deploy to that validator even when it's wedged.
  transient let BUILD_TAG : Text = "2026-10-01 quarantine stops serving";

  public query func build_tag() : async Text { BUILD_TAG };

  // ─── Helpers ───────────────────────────────────────────────────────────

  // mo:core has no toLower on Char/Text — map ASCII A–Z ourselves.
  func lowerChar(c : Char) : Char {
    if (c >= 'A' and c <= 'Z') Char.fromNat32(Char.toNat32(c) + 32) else c;
  };
  func lowerText(t : Text) : Text {
    Text.fromIter(Iter.map<Char, Char>(t.chars(), lowerChar));
  };

  // ─── Tag policy — MUST stay in sync with frontend/src/tagPolicy.ts ──────
  // The browser checks for instant feedback; THIS is the guarantee. Tags land
  // in the PUBLIC on-chain catalogue, so a slur or illegal-content tag must be
  // unstorable even when a caller bypasses the frontend and hits begin_publish
  // directly.
  transient let TAG_MAX_LEN : Nat = 30;
  transient let TAG_MAX_COUNT : Nat = 5;

  // Fold to a-z only (lowercase + common leetspeak), so "c-s-a-m" / "cs4m" /
  // "f@ggot" / "n199a" all collapse onto the same core string we test.
  func foldTag(t : Text) : Text {
    let out = List.empty<Char>();
    for (c0 in t.chars()) {
      let c = lowerChar(c0);
      let m : Char = switch (c) {
        case ('@' or '4') 'a';
        case ('3') 'e';
        case ('1' or '!' or '|') 'i';
        case ('0') 'o';
        case ('$' or '5') 's';
        case ('7') 't';
        case ('6' or '9') 'g';
        case ('8') 'b';
        case (_) c;
      };
      if (m >= 'a' and m <= 'z') List.add(out, m);
    };
    Text.fromIter(List.values(out));
  };

  transient let BANNED_SUBSTR : [Text] = [
    "csam", "childporn", "childsex", "childabuse", "childmolest", "pedophile",
    "paedophile", "pedophilia", "jailbait", "lolicon", "shotacon", "bestiality",
    "beastiality", "zoophilia", "hentai", "porn", "nsfw",
  ];
  transient let BANNED_EXACT : [Text] = [
    "cp", "pedo", "paedo", "loli", "shota", "rape", "incest", "snuff", "molest",
    "sex", "xxx", "nigger", "nigga", "faggot", "fag", "chink", "kike", "spic",
    "tranny", "retard", "gook", "wetback", "coon", "dyke", "beaner", "tard",
  ];

  // ASCII-only gate kills unicode-homoglyph evasion (only a–z survive to fold).
  func tagCharsOk(t : Text) : Bool {
    for (c in t.chars()) {
      let lc = lowerChar(c);
      let ok = (lc >= 'a' and lc <= 'z') or (lc >= '0' and lc <= '9') or lc == ' ' or lc == '-';
      if (not ok) return false;
    };
    true;
  };

  func tagAllowed(raw : Text) : Bool {
    let f = foldTag(raw);
    if (f == "") return true;
    for (b in BANNED_EXACT.values()) { if (f == b) return false };
    for (b in BANNED_SUBSTR.values()) { if (Text.contains(f, #text b)) return false };
    true;
  };

  func tagsRejection(tags : [Text]) : ?Text {
    if (tags.size() > TAG_MAX_COUNT) return ?"at most 5 tags";
    for (t in tags.values()) {
      if (Text.size(t) > TAG_MAX_LEN) return ?("a tag is too long: " # t);
      if (not tagCharsOk(t)) return ?"tags may use only letters, numbers, spaces and hyphens";
      if (not tagAllowed(t)) return ?"that tag isn't allowed here";
    };
    null;
  };

  func hasGame(slug : Text) : Bool {
    switch (Map.get(games, Text.compare, slug)) { case null false; case (?_) true };
  };

  func slugify(title : Text) : Text {
    let out = List.empty<Char>();
    var lastDash = true; // trim leading dashes
    for (c in title.chars()) {
      let lower = lowerChar(c);
      let ok = (lower >= 'a' and lower <= 'z') or (lower >= '0' and lower <= '9');
      if (ok) { List.add(out, lower); lastDash := false } else if (not lastDash) {
        List.add(out, '-');
        lastDash := true;
      };
    };
    var s = Text.fromIter(List.values(out));
    s := Text.trimEnd(s, #char '-');
    if (s == "") "game" else s;
  };

  // Ensure a unique slug by suffixing -2, -3, … on collision.
  func uniqueSlug(base : Text) : Text {
    if (not hasGame(base)) return base;
    var n = 2;
    loop {
      let cand = base # "-" # Nat.toText(n);
      if (not hasGame(cand)) return cand;
      n += 1;
    };
  };

  func contentType(path : Text) : Text {
    let lower = lowerText(path);
    func ends(suf : Text) : Bool { Text.endsWith(lower, #text suf) };
    if (ends ".html" or ends ".htm") "text/html; charset=utf-8" else if (ends ".js" or ends ".mjs") "text/javascript; charset=utf-8" else if (ends ".css") "text/css; charset=utf-8" else if (ends ".json") "application/json; charset=utf-8" else if (ends ".wasm") "application/wasm" else if (ends ".png") "image/png" else if (ends ".jpg" or ends ".jpeg") "image/jpeg" else if (ends ".gif") "image/gif" else if (ends ".svg") "image/svg+xml" else if (ends ".webp") "image/webp" else if (ends ".ico") "image/x-icon" else if (ends ".woff2") "font/woff2" else if (ends ".woff") "font/woff" else if (ends ".ttf") "font/ttf" else if (ends ".otf") "font/otf" else if (ends ".mp3") "audio/mpeg" else if (ends ".ogg" or ends ".oga") "audio/ogg" else if (ends ".wav") "audio/wav" else if (ends ".mp4") "video/mp4" else if (ends ".webm") "video/webm" else if (ends ".txt") "text/plain; charset=utf-8" else "application/octet-stream";
  };

  func favCount(slug : Text) : Nat {
    switch (Map.get(favorites, Text.compare, slug)) {
      case (?s) Set.size(s);
      case null 0;
    };
  };

  func playCount(slug : Text) : Nat {
    switch (Map.get(playCounts, Text.compare, slug)) {
      case (?n) n;
      case null 0;
    };
  };

  func view(g : Game) : GameView {
    let res = switch (Map.get(gameRes, Text.compare, g.slug)) {
      case (?r) r;
      case null { { w = DEFAULT_RES_W; h = DEFAULT_RES_H } };
    };
    {
      slug = g.slug;
      title = g.title;
      tagline = g.tagline;
      description = g.description;
      tags = g.tags;
      rating = g.rating;
      owner = g.ownerName;
      source = g.source;
      sizeBytes = g.sizeBytes;
      updatedAtNs = g.updatedAtNs;
      status = g.status;
      plays = playCount(g.slug);
      favorites = favCount(g.slug);
      // While quarantined nothing under /g/<slug>/ serves, so don't advertise
      // assets the fetch would 451 on — the shelf falls back to the generated
      // poster instead of a broken image.
      cover = switch (g.status) {
        case (#quarantined _) false;
        case (#live) {
          switch (Map.get(coverStore, Text.compare, g.slug)) {
            case (?_) true;
            case null false;
          };
        };
      };
      shots = switch (g.status) {
        case (#quarantined _) 0;
        case (#live) {
          switch (Map.get(shotStore, Text.compare, g.slug)) {
            case (?l) List.size(l);
            case null 0;
          };
        };
      };
      resW = res.w;
      resH = res.h;
    };
  };

  transient let REGION_PAGE_BYTES : Nat64 = 65536;
  func ensureRegionBytes(need : Nat64) {
    let haveBytes = Region.size(vaultRegion) * REGION_PAGE_BYTES;
    if (need > haveBytes) { ignore Region.grow(vaultRegion, (need - haveBytes + REGION_PAGE_BYTES - 1) / REGION_PAGE_BYTES) };
  };
  func regionAppend(bytes : Blob) : FileRef {
    let off = vaultTop; let len = Blob.size(bytes);
    if (len > 0) { ensureRegionBytes(off + Nat64.fromNat(len)); Region.storeBlob(vaultRegion, off, bytes); vaultTop += Nat64.fromNat(len) };
    { offset = off; length = len };
  };

  // ─── Publishing (auth-gated, chunked upload) ───────────────────────────

  public shared func begin_publish(token : Blob, meta : GameMeta) : async {
    #ok : Text;
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { #err "not signed in — a valid Memphis session is required" };
      case (?s) {
        if (strikeCount(s.anchor) >= SUSPEND_STRIKES) {
          return #err "publishing suspended — too many strikes";
        };
        if (Text.size(meta.title) == 0) return #err "title is required";
        switch (tagsRejection(meta.tags)) {
          case (?reason) return #err reason;
          case null {};
        };
        let base = slugify(meta.title);
        // A retried publish (after a transient error) shouldn't leave the first
        // attempt's half-record orphaned under the name and showing in My Games:
        // reclaim a stale UNFINISHED upload of the same name by the same owner.
        switch (Map.get(games, Text.compare, base)) {
          case (?old) {
            if (old.ownerAnchor == s.anchor and not old.finished) {
              ignore Map.delete(games, Text.compare, base);
              ignore Map.delete(pending, Text.compare, base);
              ignore Map.delete(pendingCover, Text.compare, base);
              ignore Map.delete(gameRes, Text.compare, base);
            };
          };
          case null {};
        };
        let slug = uniqueSlug(base);
        let rawW = switch (meta.resW) { case (?x) x; case null DEFAULT_RES_W };
        let rawH = switch (meta.resH) { case (?x) x; case null DEFAULT_RES_H };
        Map.add(gameRes, Text.compare, slug, {
          w = Nat.max(MIN_RES_DIM, Nat.min(MAX_RES_DIM, rawW));
          h = Nat.max(MIN_RES_DIM, Nat.min(MAX_RES_DIM, rawH));
        });
        let nowNs = Nat64.fromNat(Int.abs(Time.now()));
        let g : Game = {
          slug;
          title = meta.title;
          tagline = meta.tagline;
          description = meta.description;
          tags = meta.tags;
          rating = meta.rating;
          ownerAnchor = s.anchor;
          ownerName = s.name;
          source = #vault;
          var sizeBytes = 0;
          var status = #live;
          createdAtNs = nowNs;
          var updatedAtNs = nowNs;
          var finished = false;
        };
        Map.add(games, Text.compare, slug, g);
        Map.add(pending, Text.compare, slug, Map.empty<Text, List.List<Blob>>());
        #ok slug;
      };
    };
  };

  // Append one chunk of `path` for an in-flight upload. Chunks must arrive in
  // order per path; call finish_publish when every file is fully sent.
  public shared func put_chunk(token : Blob, slug : Text, path : Text, chunk : Blob) : async {
    #ok : Nat; // running total bytes for the game
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { return #err "not signed in" };
      case (?s) {
        switch (Map.get(games, Text.compare, slug)) {
          case null { return #err "no such upload" };
          case (?g) {
            if (g.ownerAnchor != s.anchor) return #err "not your game";
            if (g.finished) return #err "already published";
            if (Blob.size(chunk) > MAX_CHUNK_BYTES) return #err "chunk too large (64 KiB max)";
            if (g.sizeBytes + Blob.size(chunk) > MAX_GAME_BYTES) return #err "game exceeds the 256 MB cap";
            switch (Map.get(pending, Text.compare, slug)) {
              case null { return #err "upload not open" };
              case (?pf) {
                let chunks = switch (Map.get(pf, Text.compare, path)) {
                  case (?c) c;
                  case null {
                    if (Map.size(pf) >= MAX_FILES) return #err "too many files (4096 max)";
                    let c = List.empty<Blob>();
                    Map.add(pf, Text.compare, path, c);
                    c;
                  };
                };
                List.add(chunks, chunk);
                g.sizeBytes += Blob.size(chunk);
                g.updatedAtNs := Nat64.fromNat(Int.abs(Time.now()));
                #ok (g.sizeBytes);
              };
            };
          };
        };
      };
    };
  };

  // Finalize: assemble every file, require index.html at the root, go live.
  public shared func finish_publish(token : Blob, slug : Text) : async {
    #ok : Text;
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { return #err "not signed in" };
      case (?s) {
        switch (Map.get(games, Text.compare, slug)) {
          case null { return #err "no such upload" };
          case (?g) {
            if (g.ownerAnchor != s.anchor) return #err "not your game";
            if (g.finished) return #err "already published";
            switch (Map.get(pending, Text.compare, slug)) {
              case null { return #err "upload not open" };
              case (?pf) {
                switch (Map.get(pf, Text.compare, "index.html")) {
                  case null return #err "index.html must be at the root of the bundle";
                  case (?_) {};
                };
                let refs = Map.empty<Text, FileRef>();
                for ((path, chunks) in Map.entries(pf)) {
                  let start = vaultTop; var length : Nat = 0;
                  for (chunk in List.values(chunks)) { let r = regionAppend(chunk); length += r.length };
                  Map.add(refs, Text.compare, path, { offset = start; length });
                };
                Map.add(fileStore, Text.compare, slug, refs);
                ignore Map.delete(pending, Text.compare, slug);
                g.finished := true;
                g.updatedAtNs := Nat64.fromNat(Int.abs(Time.now()));
                #ok slug;
              };
            };
          };
        };
      };
    };
  };

  // Owner-only delete (also drops served bytes).
  public shared func unpublish(token : Blob, slug : Text) : async {
    #ok;
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { return #err "not signed in" };
      case (?s) {
        switch (Map.get(games, Text.compare, slug)) {
          case null { return #err "no such game" };
          case (?g) {
            if (g.ownerAnchor != s.anchor) return #err "not your game";
            ignore Map.delete(games, Text.compare, slug);
            ignore Map.delete(fileStore, Text.compare, slug);
            ignore Map.delete(pending, Text.compare, slug);
            ignore Map.delete(pendingCover, Text.compare, slug);
            ignore Map.delete(pendingShot, Text.compare, slug);
            ignore Map.delete(favorites, Text.compare, slug);
            ignore Map.delete(coverStore, Text.compare, slug);
            ignore Map.delete(shotStore, Text.compare, slug);
            ignore Map.delete(gameRes, Text.compare, slug);
            ignore Map.delete(playCounts, Text.compare, slug);
            // Reports die with the listing: a future game under this freed
            // slug is a different work and must not inherit its accusers.
            ignore Map.delete(reports, Text.compare, slug);
            #ok;
          };
        };
      };
    };
  };

  // ─── Engagement + manage ───────────────────────────────────────────────

  // Bump the play counter (public — opening a game records a play).
  public shared func record_play(slug : Text) : async () {
    switch (Map.get(games, Text.compare, slug)) {
      case (?_) { Map.add(playCounts, Text.compare, slug, playCount(slug) + 1) };
      case null {};
    };
  };

  // Toggle the caller's favorite for a game; returns the new state.
  public shared func toggle_favorite(token : Blob, slug : Text) : async {
    #ok : Bool;
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { #err "not signed in" };
      case (?s) {
        switch (Map.get(games, Text.compare, slug)) {
          case null { #err "no such game" };
          case (?_) {
            let set = switch (Map.get(favorites, Text.compare, slug)) {
              case (?x) x;
              case null {
                let x = Set.empty<Blob>();
                Map.add(favorites, Text.compare, slug, x);
                x;
              };
            };
            if (Set.contains(set, Blob.compare, s.anchor)) {
              ignore Set.delete(set, Blob.compare, s.anchor);
              #ok false;
            } else {
              Set.add(set, Blob.compare, s.anchor);
              #ok true;
            };
          };
        };
      };
    };
  };

  // Has the caller favorited this game? (auth so it stays per-anchor private.)
  public shared func is_favorite(token : Blob, slug : Text) : async Bool {
    switch (await* authed(token)) {
      case null false;
      case (?s) {
        switch (Map.get(favorites, Text.compare, slug)) {
          case (?set) Set.contains(set, Blob.compare, s.anchor);
          case null false;
        };
      };
    };
  };

  // The caller's own games (any status), for the manage page.
  public shared func my_games(token : Blob) : async [GameView] {
    switch (await* authed(token)) {
      case null { [] };
      case (?s) {
        let out = List.empty<GameView>();
        for (g in Map.values(games)) {
          // Only finished games — an in-flight/abandoned upload isn't a game yet
          // and shouldn't clutter My Games (this hid the orphaned retry record).
          if (g.ownerAnchor == s.anchor and g.finished) List.add(out, view(g));
        };
        List.toArray(out);
      };
    };
  };

  // ─── Adopting the house games ──────────────────────────────────────────
  //
  // The three seeded staff entries were created with an EMPTY ownerAnchor, and
  // every owner gate compares `g.ownerAnchor != s.anchor` — a real Memphis
  // anchor is never empty, so those listings were editable by nobody: no cover,
  // no description fix, no rating change. adopt_game is the narrow escape
  // hatch: the platform owner binds an UNOWNED listing to their own anchor,
  // after which the ordinary owner paths (update_game, covers, unpublish) apply
  // with no new privileged surface anywhere else. `ownerName` is deliberately
  // left alone so the public byline keeps reading "thebes" — who may EDIT and
  // who is CREDITED are separate questions.
  //
  // Strictly bounded: owner-only, and only while ownerAnchor is empty. It can
  // never touch a game a creator actually owns.
  public shared func adopt_game(token : Blob, slug : Text) : async {
    #ok;
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { return #err "not signed in" };
      case (?s) {
        switch (platformOwner) {
          case null { return #err "no platform owner yet — claim ownership first" };
          case (?o) {
            if (o != s.anchor) return #err "owner only";
            switch (Map.get(games, Text.compare, slug)) {
              case null { return #err "no such game" };
              case (?g) {
                if (g.ownerAnchor != ("" : Blob)) return #err "that game already has an owner";
                let adopted : Game = {
                  slug = g.slug;
                  title = g.title;
                  tagline = g.tagline;
                  description = g.description;
                  tags = g.tags;
                  rating = g.rating;
                  ownerAnchor = s.anchor; // edit rights move…
                  ownerName = g.ownerName; // …the public byline does not
                  source = g.source;
                  var sizeBytes = g.sizeBytes;
                  var status = g.status;
                  createdAtNs = g.createdAtNs;
                  var updatedAtNs = nowNs2();
                  var finished = g.finished;
                };
                Map.add(games, Text.compare, slug, adopted);
                logAction("adopt", slug, s.name, "took over an unowned house listing", 0);
                #ok;
              };
            };
          };
        };
      };
    };
  };

  // The house listings still waiting to be adopted (public query — it exposes
  // nothing the catalogue doesn't already show; the gate is on adopt_game).
  public query func adoptable_games() : async [GameView] {
    let out = List.empty<GameView>();
    for (g in Map.values(games)) {
      if (g.ownerAnchor == ("" : Blob)) List.add(out, view(g));
    };
    List.toArray(out);
  };

  // Is the caller the platform owner? Lets the manage page show the adopt
  // affordance only to the one account that can actually use it.
  public shared func am_i_owner(token : Blob) : async Bool {
    switch (await* authed(token)) {
      case null false;
      case (?s) {
        switch (platformOwner) { case (?o) o == s.anchor; case null false };
      };
    };
  };

  // Upload / replace a cover image (owner only). Served at /g/<slug>/__cover.
  public shared func set_cover(token : Blob, slug : Text, ct : Text, bytes : Blob) : async {
    #ok;
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { #err "not signed in" };
      case (?s) {
        switch (Map.get(games, Text.compare, slug)) {
          case null { #err "no such game" };
          case (?g) {
            if (g.ownerAnchor != s.anchor) return #err "not your game";
            if (Blob.size(bytes) > MAX_COVER_BYTES) return #err "cover too large (~3 MB max)";
            let ref = regionAppend(bytes);
            Map.add(coverStore, Text.compare, slug, { ct; offset = ref.offset; length = ref.length });
            #ok;
          };
        };
      };
    };
  };

  // Append one chunk of a cover image (owner only); commit with cover_commit.
  // Chunked so no single call body exceeds the node's inline ingress ceiling.
  public shared func cover_chunk(token : Blob, slug : Text, chunk : Blob) : async {
    #ok : Nat; // chunks buffered so far
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { return #err "not signed in" };
      case (?s) {
        switch (Map.get(games, Text.compare, slug)) {
          case null { return #err "no such game" };
          case (?g) {
            if (g.ownerAnchor != s.anchor) return #err "not your game";
            if (Blob.size(chunk) > MAX_CHUNK_BYTES) return #err "chunk too large (64 KiB max)";
            let chunks = switch (Map.get(pendingCover, Text.compare, slug)) {
              case (?c) c;
              case null { let c = List.empty<Blob>(); Map.add(pendingCover, Text.compare, slug, c); c };
            };
            if (List.size(chunks) >= MAX_COVER_CHUNKS) return #err "cover too large (~1.9 MB max)";
            List.add(chunks, chunk);
            #ok (List.size(chunks));
          };
        };
      };
    };
  };

  // Assemble the buffered cover into the region and publish it (owner only).
  public shared func cover_commit(token : Blob, slug : Text, ct : Text) : async {
    #ok;
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { return #err "not signed in" };
      case (?s) {
        switch (Map.get(games, Text.compare, slug)) {
          case null { return #err "no such game" };
          case (?g) {
            if (g.ownerAnchor != s.anchor) return #err "not your game";
            switch (Map.get(pendingCover, Text.compare, slug)) {
              case null { return #err "no cover upload in progress" };
              case (?chunks) {
                var total : Nat = 0;
                for (c in List.values(chunks)) total += Blob.size(c);
                if (total == 0) { ignore Map.delete(pendingCover, Text.compare, slug); return #err "empty cover" };
                if (total > MAX_COVER_BYTES) {
                  ignore Map.delete(pendingCover, Text.compare, slug);
                  return #err "cover too large (~1.9 MB max)";
                };
                let start = vaultTop; var length : Nat = 0;
                for (c in List.values(chunks)) { let r = regionAppend(c); length += r.length };
                Map.add(coverStore, Text.compare, slug, { ct; offset = start; length });
                ignore Map.delete(pendingCover, Text.compare, slug);
                #ok;
              };
            };
          };
        };
      };
    };
  };

  // Drop a cover (owner only) — the shelf falls back to the generated art, so
  // this is how a creator undoes a cover rather than being stuck with it. The
  // region bytes stay where they are (the vault is append-only; reclaiming a
  // hole would mean compaction), only the mapping goes.
  public shared func clear_cover(token : Blob, slug : Text) : async {
    #ok;
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { return #err "not signed in" };
      case (?s) {
        switch (Map.get(games, Text.compare, slug)) {
          case null { return #err "no such game" };
          case (?g) {
            if (g.ownerAnchor != s.anchor) return #err "not your game";
            ignore Map.delete(pendingCover, Text.compare, slug);
            switch (Map.take(coverStore, Text.compare, slug)) {
              case null { #err "no cover to remove" };
              case (?_) { #ok };
            };
          };
        };
      };
    };
  };

  // ─── Screenshots ───────────────────────────────────────────────────────
  //
  // Same chunked motion as covers (a whole image in one call exceeds the node's
  // inline ingress ceiling): shot_chunk × N, then shot_commit appends the
  // assembled image to the game's gallery. Served at /g/<slug>/__shot/<i>.

  public shared func shot_chunk(token : Blob, slug : Text, chunk : Blob) : async {
    #ok : Nat; // chunks buffered so far
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { return #err "not signed in" };
      case (?s) {
        switch (Map.get(games, Text.compare, slug)) {
          case null { return #err "no such game" };
          case (?g) {
            if (g.ownerAnchor != s.anchor) return #err "not your game";
            // Refuse early rather than after a long upload.
            let have = switch (Map.get(shotStore, Text.compare, slug)) {
              case (?l) List.size(l);
              case null 0;
            };
            if (have >= MAX_SHOTS) return #err ("at most " # Nat.toText(MAX_SHOTS) # " screenshots");
            if (Blob.size(chunk) > MAX_CHUNK_BYTES) return #err "chunk too large (64 KiB max)";
            let chunks = switch (Map.get(pendingShot, Text.compare, slug)) {
              case (?c) c;
              case null { let c = List.empty<Blob>(); Map.add(pendingShot, Text.compare, slug, c); c };
            };
            if (List.size(chunks) >= MAX_SHOT_CHUNKS) return #err "screenshot too large (~1.9 MB max)";
            List.add(chunks, chunk);
            #ok (List.size(chunks));
          };
        };
      };
    };
  };

  public shared func shot_commit(token : Blob, slug : Text, ct : Text) : async {
    #ok : Nat; // the new screenshot count
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { return #err "not signed in" };
      case (?s) {
        switch (Map.get(games, Text.compare, slug)) {
          case null { return #err "no such game" };
          case (?g) {
            if (g.ownerAnchor != s.anchor) return #err "not your game";
            switch (Map.get(pendingShot, Text.compare, slug)) {
              case null { return #err "no screenshot upload in progress" };
              case (?chunks) {
                var total : Nat = 0;
                for (c in List.values(chunks)) total += Blob.size(c);
                if (total == 0) {
                  ignore Map.delete(pendingShot, Text.compare, slug);
                  return #err "empty screenshot";
                };
                if (total > MAX_SHOT_BYTES) {
                  ignore Map.delete(pendingShot, Text.compare, slug);
                  return #err "screenshot too large (~1.9 MB max)";
                };
                let gallery = switch (Map.get(shotStore, Text.compare, slug)) {
                  case (?l) l;
                  case null { let l = List.empty<Shot>(); Map.add(shotStore, Text.compare, slug, l); l };
                };
                if (List.size(gallery) >= MAX_SHOTS) {
                  ignore Map.delete(pendingShot, Text.compare, slug);
                  return #err ("at most " # Nat.toText(MAX_SHOTS) # " screenshots");
                };
                let start = vaultTop; var length : Nat = 0;
                for (c in List.values(chunks)) { let r = regionAppend(c); length += r.length };
                List.add(gallery, { ct; offset = start; length });
                ignore Map.delete(pendingShot, Text.compare, slug);
                #ok (List.size(gallery));
              };
            };
          };
        };
      };
    };
  };

  // Drop one screenshot by index; the rest close ranks (the gallery is ordered,
  // so indices shift — the frontend re-reads the count after every change).
  public shared func remove_shot(token : Blob, slug : Text, index : Nat) : async {
    #ok : Nat; // remaining count
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { return #err "not signed in" };
      case (?s) {
        switch (Map.get(games, Text.compare, slug)) {
          case null { return #err "no such game" };
          case (?g) {
            if (g.ownerAnchor != s.anchor) return #err "not your game";
            switch (Map.get(shotStore, Text.compare, slug)) {
              case null { return #err "no screenshots" };
              case (?gallery) {
                let arr = List.toArray(gallery);
                if (index >= arr.size()) return #err "no screenshot at that index";
                let kept = List.empty<Shot>();
                var i : Nat = 0;
                for (sh in arr.values()) {
                  if (i != index) List.add(kept, sh);
                  i += 1;
                };
                Map.add(shotStore, Text.compare, slug, kept);
                #ok (List.size(kept));
              };
            };
          };
        };
      };
    };
  };

  // Owner-only metadata edit for a published game — title / tagline / description
  // / tags / rating / resolution. Bytes are managed via re-upload; the cover via
  // cover_chunk/commit. Lets a creator fix a listing without re-uploading it.
  public shared func update_game(token : Blob, slug : Text, meta : GameMeta) : async {
    #ok;
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { return #err "not signed in" };
      case (?s) {
        switch (Map.get(games, Text.compare, slug)) {
          case null { return #err "no such game" };
          case (?g) {
            if (g.ownerAnchor != s.anchor) return #err "not your game";
            if (Text.size(meta.title) == 0) return #err "title is required";
            switch (tagsRejection(meta.tags)) {
              case (?reason) return #err reason;
              case null {};
            };
            // Replace the record (metadata fields are immutable); slug, owner,
            // source, size, status, createdAt and finished all carry over.
            let updated : Game = {
              slug = g.slug;
              title = meta.title;
              tagline = meta.tagline;
              description = meta.description;
              tags = meta.tags;
              rating = meta.rating;
              ownerAnchor = g.ownerAnchor;
              ownerName = g.ownerName;
              source = g.source;
              var sizeBytes = g.sizeBytes;
              var status = g.status;
              createdAtNs = g.createdAtNs;
              var updatedAtNs = Nat64.fromNat(Int.abs(Time.now()));
              var finished = g.finished;
            };
            Map.add(games, Text.compare, slug, updated);
            let rawW = switch (meta.resW) { case (?x) x; case null DEFAULT_RES_W };
            let rawH = switch (meta.resH) { case (?x) x; case null DEFAULT_RES_H };
            Map.add(gameRes, Text.compare, slug, {
              w = Nat.max(MIN_RES_DIM, Nat.min(MAX_RES_DIM, rawW));
              h = Nat.max(MIN_RES_DIM, Nat.min(MAX_RES_DIM, rawH));
            });
            #ok;
          };
        };
      };
    };
  };

  // ─── Moderation ────────────────────────────────────────────────────────
  //
  // Weighted community reports quarantine a game at a threshold; a curator
  // panel votes it back to live or delists it (with a strike); a curator can
  // pull the emergency brake instantly. Every action lands on a public log.
  // (Panels are the whole curator set while it's small; hash-drawn panels of
  // three are the refinement once there are many curators.)

  func nowNs2() : Nat64 { Nat64.fromNat(Int.abs(Time.now())) };

  func logAction(action : Text, target : Text, who : Text, detail : Text, caseId : Nat) {
    List.add(modLog, { atNs = nowNs2(); action; target; who; detail; caseId });
  };

  func isCurator(anchor : Blob) : Bool { Set.contains(curators, Blob.compare, anchor) };

  func strikeCount(anchor : Blob) : Nat {
    switch (Map.get(strikes, Blob.compare, anchor)) { case (?n) n; case null 0 };
  };

  // Bootstrap: the first signed-in caller claims platform ownership and becomes
  // the first curator (trust-on-first-use — the deployer calls this once).
  public shared func claim_owner(token : Blob) : async { #ok; #err : Text } {
    switch (platformOwner) {
      case (?_) { #err "owner already claimed" };
      case null {
        switch (await* authed(token)) {
          case null { #err "not signed in" };
          case (?s) {
            platformOwner := ?s.anchor;
            Set.add(curators, Blob.compare, s.anchor);
            logAction("owner", "", s.name, "claimed platform ownership", 0);
            #ok;
          };
        };
      };
    };
  };

  // Owner-only: appoint another curator by anchor id.
  public shared func add_curator(token : Blob, curatorAnchor : Blob) : async {
    #ok;
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { #err "not signed in" };
      case (?s) {
        switch (platformOwner) {
          case (?o) {
            if (o != s.anchor) return #err "owner only";
            Set.add(curators, Blob.compare, curatorAnchor);
            logAction("curator", "", s.name, "appointed a curator", 0);
            #ok;
          };
          case null { #err "no owner yet" };
        };
      };
    };
  };

  public shared func am_i_curator(token : Blob) : async Bool {
    switch (await* authed(token)) {
      case null false;
      case (?s) isCurator(s.anchor);
    };
  };

  // Report a game. Distinct reporters accumulate; at the threshold the game is
  // auto-quarantined and a case opens.
  public shared func report(token : Blob, slug : Text, reason : Text) : async {
    #ok : Text;
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { #err "not signed in" };
      case (?s) {
        switch (Map.get(games, Text.compare, slug)) {
          case null { #err "no such game" };
          case (?g) {
            let set = switch (Map.get(reports, Text.compare, slug)) {
              case (?x) x;
              case null {
                let x = Set.empty<Blob>();
                Map.add(reports, Text.compare, slug, x);
                x;
              };
            };
            if (Set.contains(set, Blob.compare, s.anchor)) return #err "you already reported this";
            Set.add(set, Blob.compare, s.anchor);
            logAction("report", slug, s.name, reason, 0);
            switch (g.status) {
              case (#live) {
                if (Set.size(set) >= QUARANTINE_THRESHOLD) {
                  caseSeq += 1;
                  let id = caseSeq;
                  g.status := #quarantined { caseId = id };
                  Map.add(
                    cases,
                    Nat.compare,
                    id,
                    {
                      id;
                      slug;
                      kind = (#reports : CaseKind);
                      openedAtNs = nowNs2();
                      votes = Map.empty<Blob, Verdict>();
                      var resolved = (null : ?Verdict);
                    },
                  );
                  logAction(
                    "quarantine",
                    slug,
                    "automatic (report threshold)",
                    "reached " # Nat.toText(QUARANTINE_THRESHOLD) # " reports",
                    id,
                  );
                };
              };
              case (_) {};
            };
            #ok "reported";
          };
        };
      };
    };
  };

  // Curator emergency brake — freeze instantly, opening a case for ratification
  // (for malware / illegal content that cannot wait for a report threshold).
  public shared func emergency_freeze(token : Blob, slug : Text, reason : Text) : async {
    #ok : Nat;
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { #err "not signed in" };
      case (?s) {
        if (not isCurator(s.anchor)) return #err "curators only";
        switch (Map.get(games, Text.compare, slug)) {
          case null { #err "no such game" };
          case (?g) {
            // One active case per game: freezing an already-quarantined game
            // would open a second case, and the stale one could later revive
            // the listing out from under the newer one.
            switch (g.status) {
              case (#quarantined q) {
                return #err ("already quarantined — case " # Nat.toText(q.caseId) # " is open");
              };
              case (#live) {};
            };
            caseSeq += 1;
            let id = caseSeq;
            g.status := #quarantined { caseId = id };
            Map.add(
              cases,
              Nat.compare,
              id,
              {
                id;
                slug;
                kind = (#emergency : CaseKind);
                openedAtNs = nowNs2();
                votes = Map.empty<Blob, Verdict>();
                var resolved = (null : ?Verdict);
              },
            );
            logAction("emergency-freeze", slug, s.name, reason, id);
            #ok id;
          };
        };
      };
    };
  };

  // Curator vote on an open case; at PANEL_MAJORITY it resolves — restore the
  // game, or delist it and strike the owner.
  public shared func vote(token : Blob, caseId : Nat, restore : Bool) : async {
    #ok : Text;
    #err : Text;
  } {
    switch (await* authed(token)) {
      case null { #err "not signed in" };
      case (?s) {
        if (not isCurator(s.anchor)) return #err "curators only";
        switch (Map.get(cases, Nat.compare, caseId)) {
          case null { #err "no such case" };
          case (?c) {
            switch (c.resolved) {
              case (?_) return #err "case already resolved";
              case null {};
            };
            let verdict : Verdict = if (restore) #restore else #delist;
            Map.add(c.votes, Blob.compare, s.anchor, verdict);
            logAction("vote", c.slug, s.name, if (restore) "restore" else "delist", caseId);
            var restores = 0;
            var delists = 0;
            for (v in Map.values(c.votes)) {
              switch (v) { case (#restore) restores += 1; case (#delist) delists += 1 };
            };
            // A verdict only acts on the game while it is quarantined BY THIS
            // case — a stale case must never flip a listing a newer case (or
            // nobody) governs. The case itself still resolves either way.
            if (restores >= PANEL_MAJORITY) {
              c.resolved := ?#restore;
              switch (Map.get(games, Text.compare, c.slug)) {
                case (?g) {
                  switch (g.status) {
                    case (#quarantined q) {
                      if (q.caseId == c.id) {
                        g.status := #live;
                        ignore Map.delete(reports, Text.compare, c.slug);
                      };
                    };
                    case (#live) {};
                  };
                };
                case null {};
              };
              logAction("restore", c.slug, "panel", "reports not substantiated", caseId);
            } else if (delists >= PANEL_MAJORITY) {
              c.resolved := ?#delist;
              switch (Map.get(games, Text.compare, c.slug)) {
                case (?g) {
                  switch (g.status) {
                    case (#quarantined q) {
                      if (q.caseId == c.id) {
                        let next = strikeCount(g.ownerAnchor) + 1;
                        Map.add(strikes, Blob.compare, g.ownerAnchor, next);
                        logAction("delist", c.slug, "panel", "removed from the shelves", caseId);
                        logAction("strike", c.slug, "panel", g.ownerName # " — strike " # Nat.toText(next), caseId);
                        ignore Map.delete(games, Text.compare, c.slug);
                        ignore Map.delete(fileStore, Text.compare, c.slug);
                        ignore Map.delete(coverStore, Text.compare, c.slug);
                        ignore Map.delete(shotStore, Text.compare, c.slug);
                        ignore Map.delete(favorites, Text.compare, c.slug);
                        ignore Map.delete(gameRes, Text.compare, c.slug);
                        ignore Map.delete(playCounts, Text.compare, c.slug);
                        // Same rule as unpublish: reports die with the
                        // listing, or the next publisher under this freed
                        // slug inherits its accusers and one fresh report
                        // re-quarantines a game nobody has seen.
                        ignore Map.delete(reports, Text.compare, c.slug);
                      };
                    };
                    case (#live) {};
                  };
                };
                case null {};
              };
            };
            #ok "voted";
          };
        };
      };
    };
  };

  public query func mod_log() : async [LogEntry] {
    Array.reverse(List.toArray(modLog)); // newest first
  };

  public query func open_cases() : async [CaseView] {
    let out = List.empty<CaseView>();
    for (c in Map.values(cases)) {
      var restores = 0;
      var delists = 0;
      for (v in Map.values(c.votes)) {
        switch (v) { case (#restore) restores += 1; case (#delist) delists += 1 };
      };
      List.add(
        out,
        {
          id = c.id;
          slug = c.slug;
          kind = switch (c.kind) { case (#reports) "reports"; case (#emergency) "emergency" };
          openedAtNs = c.openedAtNs;
          restoreVotes = restores;
          delistVotes = delists;
          resolved = switch (c.resolved) {
            case (?#restore) ?"restore";
            case (?#delist) ?"delist";
            case null null;
          };
        },
      );
    };
    List.toArray(out);
  };

  // ─── Catalogue (public queries) ────────────────────────────────────────

  public query func catalogue() : async [GameView] {
    let out = List.empty<GameView>();
    for (g in Map.values(games)) {
      if (g.finished) { List.add(out, view(g)) };
    };
    List.toArray(out);
  };

  public query func game(slug : Text) : async ?GameView {
    switch (Map.get(games, Text.compare, slug)) {
      case (?g) { if (g.finished) ?view(g) else null };
      case null { null };
    };
  };

  // ─── Serving (http_request) ────────────────────────────────────────────

  type HeaderField = (Text, Text);
  type HttpRequest = {
    method : Text;
    url : Text;
    headers : [HeaderField];
    body : Blob;
  };

  // Streaming (docs: large-file serving). A file bigger than one response is
  // returned as the first chunk inline plus a token the NODE follows via
  // http_request_streaming_callback (the engine can't self-call a query). The
  // token is our own small record — round-trips cleanly through the engine's
  // opaque-token path.
  type StreamingToken = { slug : Text; path : Text; index : Nat };
  type StreamingCallbackResponse = { body : Blob; token : ?StreamingToken };
  type StreamingStrategy = {
    #Callback : {
      token : StreamingToken;
      callback : shared query (StreamingToken) -> async StreamingCallbackResponse;
    };
  };
  type HttpResponse = {
    status_code : Nat16;
    headers : [HeaderField];
    body : Blob;
    streaming_strategy : ?StreamingStrategy;
  };

  func notFound(msg : Text) : HttpResponse {
    {
      status_code = 404;
      headers = [("content-type", "text/plain; charset=utf-8")];
      body = Text.encodeUtf8(msg);
      streaming_strategy = null;
    };
  };

  func chunkOfRegion(ref : FileRef, index : Nat) : Blob {
    let start = index * SERVE_CHUNK;
    if (start >= ref.length) return "" : Blob;
    Region.loadBlob(vaultRegion, ref.offset + Nat64.fromNat(start), Nat.min(SERVE_CHUNK, ref.length - start));
  };

  // A response for a stored file: inline when it fits one response, else the
  // first chunk + a streaming strategy the node follows for the rest.
  func serveBytes(slug : Text, path : Text, ct : Text, ref : FileRef) : HttpResponse {
    let headers = [
      ("content-type", ct),
      ("access-control-allow-origin", "*"),
      ("cache-control", "public, max-age=60"),
    ];
    if (ref.length <= SERVE_CHUNK) {
      { status_code = 200; headers; body = chunkOfRegion(ref, 0); streaming_strategy = null };
    } else {
      {
        status_code = 200;
        headers;
        body = chunkOfRegion(ref, 0);
        streaming_strategy = ?(
          #Callback {
            token = { slug; path; index = 1 };
            callback = http_request_streaming_callback;
          }
        );
      };
    };
  };

  // Serve a vault game's files at /g/<slug>/<path> (empty path → index.html).
  public query func http_request(req : HttpRequest) : async HttpResponse {
    // Strip the query string, then split the path.
    let raw = req.url;
    let qparts = Text.split(raw, #char '?');
    let pathOnly = switch (qparts.next()) {
      case (?p) p;
      case null raw;
    };
    let segs = Iter.toArray(
      Iter.filter<Text>(Text.split(pathOnly, #char '/'), func(x) { x != "" })
    );
    if (segs.size() < 2 or segs[0] != "g") {
      return notFound("thebes-games vault — no game at " # pathOnly);
    };
    let slug = segs[1];
    let file = if (segs.size() == 2) "index.html" else {
      Text.join(Iter.fromArray(Array.sliceToArray(segs, 2, segs.size())), "/");
    };
    // Quarantined (report threshold or emergency freeze): NOTHING under
    // /g/<slug>/ serves — not the bundle, not the cover, not the shots. This
    // is what makes the emergency brake actually stop malware, not just hide
    // the card; without it quarantine only flips a flag the frontend honors.
    switch (Map.get(games, Text.compare, slug)) {
      case (?g) {
        switch (g.status) {
          case (#quarantined _) {
            return {
              status_code = 451;
              headers = [("content-type", "text/plain; charset=utf-8")];
              body = Text.encodeUtf8("'" # slug # "' is under review by the curator panel");
              streaming_strategy = null;
            };
          };
          case (#live) {};
        };
      };
      case null {};
    };
    // A screenshot: /g/<slug>/__shot/<i>, served inline like a cover.
    if (Text.startsWith(file, #text "__shot/")) {
      let idxText = Text.replace(file, #text "__shot/", "");
      switch (Nat.fromText(idxText)) {
        case null { return notFound("bad screenshot index '" # idxText # "'") };
        case (?i) {
          switch (Map.get(shotStore, Text.compare, slug)) {
            case null { return notFound("no screenshots for '" # slug # "'") };
            case (?gallery) {
              let arr = List.toArray(gallery);
              if (i >= arr.size()) return notFound("no screenshot " # idxText);
              let sh = arr[i];
              return {
                status_code = 200;
                headers = [
                  ("content-type", sh.ct),
                  ("access-control-allow-origin", "*"),
                  ("cache-control", "public, max-age=300"),
                ];
                body = Region.loadBlob(vaultRegion, sh.offset, sh.length);
                streaming_strategy = null;
              };
            };
          };
        };
      };
    };
    // The creator's cover image (if any) is served from its own store.
    if (file == "__cover") {
      switch (Map.get(coverStore, Text.compare, slug)) {
        case (?c) {
          return {
            status_code = 200;
            headers = [
              ("content-type", c.ct),
              ("access-control-allow-origin", "*"),
              ("cache-control", "public, max-age=300"),
            ];
            body = Region.loadBlob(vaultRegion, c.offset, c.length);
            streaming_strategy = null;
          };
        };
        case null { return notFound("no cover for '" # slug # "'") };
      };
    };
    switch (Map.get(fileStore, Text.compare, slug)) {
      case null { notFound("no game '" # slug # "' in the vault") };
      case (?fm) {
        switch (Map.get(fm, Text.compare, file)) {
          case (?ref) { serveBytes(slug, file, contentType(file), ref) };
          case null { notFound("no file '" # file # "' in '" # slug # "'") };
        };
      };
    };
  };

  // The node follows this to fetch the next chunk of a big file (see the
  // streaming strategy in serveBytes). Serves only public vault bytes — the
  // same bytes http_request already serves, so no new exposure.
  public query func http_request_streaming_callback(token : StreamingToken) : async StreamingCallbackResponse {
    // A stream that began before a quarantine stops at its next chunk — the
    // gate in http_request can't see chunks the node pulls via this callback.
    switch (Map.get(games, Text.compare, token.slug)) {
      case (?g) {
        switch (g.status) {
          case (#quarantined _) { return { body = Blob.fromArray([]); token = null } };
          case (#live) {};
        };
      };
      case null {};
    };
    switch (Map.get(fileStore, Text.compare, token.slug)) {
      case null { { body = Blob.fromArray([]); token = null } };
      case (?fm) {
        switch (Map.get(fm, Text.compare, token.path)) {
          case null { { body = Blob.fromArray([]); token = null } };
          case (?ref) {
            let more = (token.index + 1) * SERVE_CHUNK < ref.length;
            {
              body = chunkOfRegion(ref, token.index);
              token = if (more) ?{
                slug = token.slug;
                path = token.path;
                index = token.index + 1;
              } else null;
            };
          };
        };
      };
    };
  };



  // ─── Seed: the three games already live on the WAN, as #canister entries ─

  func seedGame(slug : Text, title : Text, tagline : Text, tags : [Text], rating : Rating, cid : Text) {
    if (hasGame(slug)) return;
    let g : Game = {
      slug;
      title;
      tagline;
      description = tagline;
      tags;
      rating;
      ownerAnchor = "" : Blob;
      ownerName = "thebes";
      source = #canister cid;
      var sizeBytes = 0;
      var status = #live;
      createdAtNs = 0;
      var updatedAtNs = 0;
      var finished = true;
    };
    Map.add(games, Text.compare, slug, g);
  };

  // Runs on first install; upgrades keep the (possibly edited) catalogue.
  seedGame("basra", "Basra", "The Nile's own fishing card game.", ["cards", "classic"], #E, "171051190939374");
  seedGame("revenge-of-the-retrieved", "Revenge of the Retrieved", "They deleted your save. Retrieve everything.", ["arcade", "2d"], #E, "99368548869172");
  seedGame("revenge-of-the-retrieved-3d", "Revenge of the Retrieved 3D", "The archives got deeper.", ["arcade", "3d"], #T, "115382987180688");

  // ─── Legacy demo surface (kept so existing callers don't break) ────────

  public query func greet(name : Text) : async Text {
    "Greetings, " # name # " — from thebes-games registry+vault, live on Thebes.";
  };
};
