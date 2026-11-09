import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.RELAY_API_TARGET ?? "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": apiTarget
    }
  }
});
