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

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    proxy: {
      "/api": {
        target: gateway,
        changeOrigin: true,
      },
    },
  },
});
