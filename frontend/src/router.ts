/**
 * router.ts — a hash router in ~40 lines.
 *
 * The app is served from the chain under /_/raw/<cid>/, a path we do not
 * control and where the boundary serves exact files only — no rewrite
 * rules, so history-API routing would 404 on refresh. Hash routes
 * (#/game/basra) survive refresh anywhere the bundle is served from, at
 * the cost of zero dependencies.
 */
import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "game"; slug: string }
  | { name: "upload" }
  | { name: "mine" }
  | { name: "log" }
  | { name: "admin" };

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  switch (parts[0]) {
    case "game":
      return parts[1] ? { name: "game", slug: parts[1] } : { name: "home" };
    case "upload":
      return { name: "upload" };
    case "mine":
      return { name: "mine" };
    case "log":
      return { name: "log" };
    case "admin":
      return { name: "admin" };
    default:
      return { name: "home" };
  }
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = () => {
      setRoute(parse(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}
