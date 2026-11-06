import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Project site: https://zhuyanhe1975-hit.github.io/hit_exolimb_ai/
const pagesBase = "/hit_exolimb_ai/";

export default defineConfig({
  base: pagesBase,
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173
  }
});
