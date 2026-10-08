import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// The web app lives in web/ and is built into dist/web, next to the compiled server which serves it.
export default defineConfig({
  root: "web",
  plugins: [preact()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    // `npm run dev:web` with the server running on 9501 (`npm run dev`)
    proxy: { "/api": "http://localhost:9501" },
  },
});
