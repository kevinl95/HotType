#!/usr/bin/env -S node --experimental-strip-types
// Bundles src/client -> public/game.js and src/server -> dist/server/index.js
//   build.ts [--minify] [--watch]
import type { BuildOptions } from "esbuild";
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const minify = process.argv.includes("--minify");

const base: BuildOptions = {
  bundle: true,
  logLevel: "info",
  sourcemap: "linked",
  target: "es2023",
  minify,
};

const clientOpts: BuildOptions = {
  ...base,
  entryPoints: ["src/client/game.tsx", "src/client/splash.ts"],
  outdir: "public",
  format: "esm",
  platform: "browser",
  jsx: "automatic",
};

const serverOpts: BuildOptions = {
  ...base,
  entryPoints: ["src/server/index.ts"],
  outdir: "dist/server",
  format: "cjs",
  platform: "node",
};

if (watch) {
  const c = await esbuild.context(clientOpts);
  const s = await esbuild.context(serverOpts);
  await Promise.all([c.watch(), s.watch()]);
  console.log("watching for changes…");
} else {
  await Promise.all([esbuild.build(clientOpts), esbuild.build(serverOpts)]);
  console.log("build complete");
}
