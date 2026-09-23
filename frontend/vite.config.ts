import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" — the bundle is served from the chain under
// /_/raw/<cid>/, so every asset reference must be relative.
//
// The dev proxy forwards /api to the same chain the project deploys to by
// default — the localhost chain `thebes-deploy start` runs. Point a dev
// session at another chain with THEBES_GATEWAY, e.g.
//   THEBES_GATEWAY=https://memphis.mercaturaforum.com npm run dev
const gateway = process.env.THEBES_GATEWAY ?? "http://127.0.0.1:8180";

// The sandboxed player embeds each game in an opaque-origin iframe, so a
// game's assets are fetched cross-origin (Origin: null) and need
// `access-control-allow-origin`. The gateway already sends it, but pin
// it on the proxied responses too so a dev session never depends on the
// upstream having set it.
const allowCors = (proxy: {
  on: (
    e: "proxyRes",
    cb: (res: { headers: Record<string, string | undefined> }) => void
  ) => void;
}) => {
  proxy.on("proxyRes", (res) => {
    res.headers["access-control-allow-origin"] = "*";
  });
};

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    // Pin to IPv4 loopback: node resolves `localhost` to ::1 on this box,
    // and VS Code / ssh -L port forwards connect to 127.0.0.1 — an
    // IPv6-only bind leaves them hanging forever.
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: gateway,
        changeOrigin: true,
        configure: allowCors,
      },
      // The sandboxed player embeds other canisters' frontends by their
      // gateway path (/_/raw/<cid>/…). Proxying /_ makes those embeds
      // work under `npm run dev` too — against the WAN's live games:
      //   THEBES_GATEWAY=https://memphis.mercaturaforum.com npm run dev
      "/_": {
        target: gateway,
        changeOrigin: true,
        configure: allowCors,
      },
    },
  },
});
