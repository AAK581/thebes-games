/// MockMemphis — a stand-in for the Memphis auth canister (cid 921), local
/// testing only. Any token decodes to a session whose anchor IS the token
/// bytes and whose display tag is the token text; tokens starting with "bad"
/// (and undecodable/empty ones) are rejected. This lets a test script play an
/// arbitrary cast of users without passkeys.
import Nat64 "mo:core/Nat64";
import Int "mo:core/Int";
import Time "mo:core/Time";
import Text "mo:core/Text";

persistent actor MockMemphis {
  type WhoAmIResult = {
    anchor_id : Blob;
    session_expires_ns : Nat64;
    display_tag : Text;
  };
  type MemphisError = { #NotAuthenticated };

  public shared func whoami_u(token : Blob) : async {
    #Ok : WhoAmIResult;
    #Err : MemphisError;
  } {
    let name = switch (Text.decodeUtf8(token)) { case (?t) t; case null "" };
    if (name == "" or Text.startsWith(name, #text "bad")) {
      return #Err(#NotAuthenticated);
    };
    #Ok {
      anchor_id = token;
      session_expires_ns = Nat64.fromNat(Int.abs(Time.now()) + 3_600_000_000_000);
      display_tag = name;
    };
  };
};
