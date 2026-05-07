import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  outdir: "dist",
  external: ["@aws-sdk/*"],
  format: "cjs",
});

console.log("✅ Build complete → dist/index.js");
