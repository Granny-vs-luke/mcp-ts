import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/adapters/ai-sdk.ts", "src/adapters/mcp.ts"],
  format: ["esm"],
  clean: true,
  dts: true,
  platform: "neutral",
  target: "es2020",
  bundle: true,
  minify: false,
  sourcemap: true,
  external: ["ai"],
  config: false
});
