import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  server: {
    port: 41789,
    host: "127.0.0.1",
    strictPort: true,
  },

  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // AI bindings default to remote and would force Cloudflare OAuth on boot, so remote
      // bindings stay off unless CUTMAN_REMOTE_AI=true. run-vite-dev.mjs then requires
      // CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID so Wrangler never opens the login.
      // Only AI goes remote: D1, KV, and email have no `remote: true` and stay local.
      remoteBindings: process.env.CUTMAN_REMOTE_AI?.trim() === "true",
      ...(process.env.CUTMAN_WRANGLER_CONFIG
        ? { configPath: process.env.CUTMAN_WRANGLER_CONFIG }
        : {}),
    }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],

  ssr: {
    noExternal: ["@clerk/react-router"],
  },
});