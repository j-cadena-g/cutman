import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  server: {
    port: 41789,
    host: "127.0.0.1",
  },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // AI bindings default to remote and would force Cloudflare OAuth on boot.
      remoteBindings: false,
    }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
