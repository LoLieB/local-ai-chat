import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.HOST || "127.0.0.1";
const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:8787";
const port = Number(process.env.VITE_PORT || 5173);

export default defineConfig({
  plugins: [react()],
  define: {
    __LOCAL_AI_CHAT_SERVER_TOKEN__: JSON.stringify(process.env.SERVER_TOKEN || "")
  },
  build: {
    target: "es2018",
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client"],
          app: ["src/App.tsx", "src/api.ts"]
        }
      }
    }
  },
  server: {
    host,
    port,
    strictPort: true,
    proxy: {
      "/api": backendUrl
    }
  }
});
