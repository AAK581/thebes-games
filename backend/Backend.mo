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

  // Limits (MVP; documented, not stubs).
  transient let MAX_GAME_BYTES : Nat = 16 * 1024 * 1024; // 16 MB / game
  transient let MAX_FILE_BYTES : Nat = 2 * 1024 * 1024; // 2 MB / file (served whole; no streaming)
  transient let MAX_FILES : Nat = 512;
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
            if (g.sizeBytes + Blob.size(chunk) > MAX_GAME_BYTES) return #err "game exceeds 16 MB";
            switch (Map.get(pending, Text.compare, slug)) {
              case null { return #err "upload not open" };
              case (?pf) {
                let chunks = switch (Map.get(pf, Text.compare, path)) {
                  case (?c) c;
                  case null {
                    if (Map.size(pf) >= MAX_FILES) return #err "too many files (512 max)";
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
                  let bytes = concatBlobs(chunks);
                  if (Blob.size(bytes) > MAX_FILE_BYTES) {
                    return #err ("file too large (2 MB max): " # path);
                  };
                  Map.add(assembled, Text.compare, path, bytes);
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
            #ok;
          };
        };
      };
    };
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
  type HttpResponse = {
    status_code : Nat16;
    headers : [HeaderField];
    body : Blob;
  };

  func notFound(msg : Text) : HttpResponse {
    {
      status_code = 404;
      headers = [("content-type", "text/plain; charset=utf-8")];
      body = Text.encodeUtf8(msg);
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
    switch (Map.get(files, Text.compare, slug)) {
      case null { notFound("no game '" # slug # "' in the vault") };
      case (?fm) {
        switch (Map.get(fm, Text.compare, file)) {
          case (?bytes) {
            {
              status_code = 200;
              headers = [
                ("content-type", contentType(file)),
                // Opaque-origin players fetch cross-origin; allow it (the
                // gateway does the same for canister assets).
                ("access-control-allow-origin", "*"),
                ("cache-control", "public, max-age=60"),
              ];
              body = bytes;
            };
          };
          case null { notFound("no file '" # file # "' in '" # slug # "'") };
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
