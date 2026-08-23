// frontend/vite.config.js
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  plugins: [vue()],
  server: { proxy: { "/api": "http://localhost:9000", "/hook": "http://localhost:9000" } },
});