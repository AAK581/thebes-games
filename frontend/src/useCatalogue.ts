/**
 * useCatalogue — the games shelf, from the on-chain registry.
 *
 * Falls back to the mock catalogue (data.ts) while the query is in flight OR
 * if the backend is unreachable, so localhost dev and a cold start never show
 * an empty shelf. Once the chain answers, its catalogue (the 3 seeds + every
 * uploaded game) replaces the mock.
 */
import { useEffect, useState } from "react";
import { GAMES, type Game } from "./data";
import { catalogue } from "./registry";

export function useCatalogue(): { games: Game[]; loading: boolean; error?: string } {
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    catalogue()
      .then((g) => {
        if (alive) setGames(g);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  return { games: games ?? GAMES, loading: games === null && !error, error };
}
