// thebes-games backend — a starter canister on the Thebes substrate.
//
// Two surfaces, mirroring the classic hello template:
//
//  * greet(name)   — a query: read-only, answered locally, no consensus.
//  * increment()   — an update: ordered by consensus, executed on every
//    validator.
//  * get_count()   — the counter's query.
//
// UPGRADES KEEP YOUR STATE — because of one flag in thebes.toml.
//
// Thebes implements the classic upgrade contract: `thebes-deploy deploy
// --upgrade` runs pre_upgrade, carries the canister's STABLE memory to a
// fresh instance of the new module, and runs post_upgrade. Your thebes.toml
// builds this canister with `moc --legacy-persistence`, which compiles for
// exactly that contract — the compiler generates the hooks that serialise
// the `var`s below into stable memory and read them back. So `count`
// survives a code change. Verified end to end: a counter at 3 read 3 after
// an upgrade to a genuinely new build.
//
// moc's *default*, enhanced orthogonal persistence, keeps state in the
// wasm's MAIN memory and relies on the replica retaining that memory across
// an upgrade. This platform does not do that, so an EOP build comes back up
// blank — a counter at 3 reads 0. Leave `--legacy-persistence` in place.
// If you remove it, `deploy --upgrade` refuses rather than wiping you
// silently, and tells you how to put it back.
//
// One precondition, on the cluster rather than on your code: a 32-bit
// Motoko module is only admitted once the chain has passed its legacy-ABI
// activation height. `deploy` checks that for you before it uploads
// anything.

persistent actor Backend {
  var count : Nat = 0;

  public query func greet(name : Text) : async Text {
    "Greetings, " # name # " — from thebes-games, live on Thebes."
  };

  public func increment() : async Nat {
    count += 1;
    count
  };

  public query func get_count() : async Nat {
    count
  };
};
