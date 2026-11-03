import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

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
  // V2 feature flags (T1002): the frontend reads the SAME env key names as
  // backend/src/config/flags.ts (`V2_RESUME_STUDIO`, ...), so the exposed
  // prefix is widened from the default `VITE_` to include `V2_`. Nothing is
  // exposed unless an operator actually sets a `V2_*` var, so a build with no
  // flags set is unchanged; these are non-secret on/off switches, not
  // credentials, so widening the prefix does not widen what is leaked.
  envPrefix: ['VITE_', 'V2_'],
  // Force a clean re-optimization of deps on every dev start. This prevents a
  // stale/partially-written `.vite/deps` cache (left behind by an interrupted
  // or concurrent `npm run dev`) from being served to the browser, which can
  // surface as a "Identifier 'Dialog' has already been declared" SyntaxError
  // when an old optimize chunk is loaded alongside the current one.
  optimizeDeps: {
    force: true,
  },
}));
