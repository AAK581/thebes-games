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

  type Cover = { ct : Text; bytes : Blob };

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

  // slug → Game
  let games = Map.empty<Text, Game>();
  // slug → (path → file bytes), for #vault games (finished files)
  let files = Map.empty<Text, Map.Map<Text, Blob>>();
  // slug → (path → chunks in order), for uploads in flight
  let pending = Map.empty<Text, Map.Map<Text, List.List<Blob>>>();
  // slug → set of anchors that favorited it
  let favorites = Map.empty<Text, Set.Set<Blob>>();
  // slug → cover image (served at /g/<slug>/__cover)
  let covers = Map.empty<Text, Cover>();
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
  transient let MAX_COVER_BYTES : Nat = 3_000_000;
  transient let SERVE_CHUNK : Nat = 1_900_000; // bytes per streamed response chunk
  transient let MAX_FILES : Nat = 4096;
  transient let MAX_CHUNK_BYTES : Nat = 64 * 1024; // one put_chunk

  // ─── Helpers ───────────────────────────────────────────────────────────

  // mo:core has no toLower on Char/Text — map ASCII A–Z ourselves.
  func lowerChar(c : Char) : Char {
    if (c >= 'A' and c <= 'Z') Char.fromNat32(Char.toNat32(c) + 32) else c;
  };
  func lowerText(t : Text) : Text {
    Text.fromIter(Iter.map<Char, Char>(t.chars(), lowerChar));
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
      cover = switch (Map.get(covers, Text.compare, g.slug)) {
        case (?_) true;
        case null false;
      };
    };
  };

  func concatBlobs(chunks : List.List<Blob>) : Blob {
    let buf = List.empty<Nat8>();
    for (c in List.values(chunks)) {
      for (b in Blob.toArray(c).values()) { List.add(buf, b) };
    };
    Blob.fromArray(List.toArray(buf));
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
        let slug = uniqueSlug(slugify(meta.title));
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
                // Assemble each file once.
                let assembled = Map.empty<Text, Blob>();
                for ((path, chunks) in Map.entries(pf)) {
                  // No per-file cap: files are served via the streaming
                  // callback, bounded only by the per-game total already
                  // enforced at put_chunk time.
                  Map.add(assembled, Text.compare, path, concatBlobs(chunks));
                };
                Map.add(files, Text.compare, slug, assembled);
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
            ignore Map.delete(files, Text.compare, slug);
            ignore Map.delete(pending, Text.compare, slug);
            ignore Map.delete(favorites, Text.compare, slug);
            ignore Map.delete(covers, Text.compare, slug);
            ignore Map.delete(playCounts, Text.compare, slug);
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
          if (g.ownerAnchor == s.anchor) List.add(out, view(g));
        };
        List.toArray(out);
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
            Map.add(covers, Text.compare, slug, { ct; bytes });
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
            if (restores >= PANEL_MAJORITY) {
              c.resolved := ?#restore;
              switch (Map.get(games, Text.compare, c.slug)) {
                case (?g) g.status := #live;
                case null {};
              };
              ignore Map.delete(reports, Text.compare, c.slug);
              logAction("restore", c.slug, "panel", "reports not substantiated", caseId);
            } else if (delists >= PANEL_MAJORITY) {
              c.resolved := ?#delist;
              switch (Map.get(games, Text.compare, c.slug)) {
                case (?g) {
                  let next = strikeCount(g.ownerAnchor) + 1;
                  Map.add(strikes, Blob.compare, g.ownerAnchor, next);
                  logAction("delist", c.slug, "panel", "removed from the shelves", caseId);
                  logAction("strike", c.slug, "panel", g.ownerName # " — strike " # Nat.toText(next), caseId);
                  ignore Map.delete(games, Text.compare, c.slug);
                  ignore Map.delete(files, Text.compare, c.slug);
                  ignore Map.delete(covers, Text.compare, c.slug);
                  ignore Map.delete(favorites, Text.compare, c.slug);
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

  // The `index`-th SERVE_CHUNK-sized slice of `bytes`.
  func chunkOf(bytes : Blob, index : Nat) : Blob {
    let arr = Blob.toArray(bytes);
    let start = index * SERVE_CHUNK;
    if (start >= arr.size()) return Blob.fromArray([]);
    let end = Nat.min(start + SERVE_CHUNK, arr.size());
    Blob.fromArray(Array.sliceToArray(arr, start, end));
  };

  // A response for a stored file: inline when it fits one response, else the
  // first chunk + a streaming strategy the node follows for the rest.
  func serveBytes(slug : Text, path : Text, ct : Text, bytes : Blob) : HttpResponse {
    let headers = [
      ("content-type", ct),
      ("access-control-allow-origin", "*"),
      ("cache-control", "public, max-age=60"),
    ];
    if (Blob.size(bytes) <= SERVE_CHUNK) {
      { status_code = 200; headers; body = bytes; streaming_strategy = null };
    } else {
      {
        status_code = 200;
        headers;
        body = chunkOf(bytes, 0);
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
    // The creator's cover image (if any) is served from its own store.
    if (file == "__cover") {
      switch (Map.get(covers, Text.compare, slug)) {
        case (?c) {
          return {
            status_code = 200;
            headers = [
              ("content-type", c.ct),
              ("access-control-allow-origin", "*"),
              ("cache-control", "public, max-age=300"),
            ];
            body = c.bytes;
            streaming_strategy = null;
          };
        };
        case null { return notFound("no cover for '" # slug # "'") };
      };
    };
    switch (Map.get(files, Text.compare, slug)) {
      case null { notFound("no game '" # slug # "' in the vault") };
      case (?fm) {
        switch (Map.get(fm, Text.compare, file)) {
          case (?bytes) { serveBytes(slug, file, contentType(file), bytes) };
          case null { notFound("no file '" # file # "' in '" # slug # "'") };
        };
      };
    };
  };

  // The node follows this to fetch the next chunk of a big file (see the
  // streaming strategy in serveBytes). Serves only public vault bytes — the
  // same bytes http_request already serves, so no new exposure.
  public query func http_request_streaming_callback(token : StreamingToken) : async StreamingCallbackResponse {
    switch (Map.get(files, Text.compare, token.slug)) {
      case null { { body = Blob.fromArray([]); token = null } };
      case (?fm) {
        switch (Map.get(fm, Text.compare, token.path)) {
          case null { { body = Blob.fromArray([]); token = null } };
          case (?bytes) {
            let more = (token.index + 1) * SERVE_CHUNK < Blob.size(bytes);
            {
              body = chunkOf(bytes, token.index);
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
