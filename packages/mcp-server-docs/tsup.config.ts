import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts", "src/http.ts"],
  format: ["esm"],
  clean: true,
  minify: true,
  dts: true,
  platform: "node",
  target: "node18",
  bundle: true,
  // This prevents tsup from looking up to the root config
  // which causes issues in isolated Vercel builds
  config: false, 
});
