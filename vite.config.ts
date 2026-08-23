import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
// import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Force a clean re-optimization of deps on every dev start. This prevents a
  // stale/partially-written `.vite/deps` cache (left behind by an interrupted
  // or concurrent `npm run dev`) from being served to the browser, which can
  // surface as a "Identifier 'Dialog' has already been declared" SyntaxError
  // when an old optimize chunk is loaded alongside the current one.
  optimizeDeps: {
    force: true,
  },
}));
