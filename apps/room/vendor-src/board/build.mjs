import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../public/vendor/board");
const pkg = join(here, "node_modules/@excalidraw/excalidraw");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, "src/entry.jsx")],
  outdir: out,
  splitting: true,
  entryNames: "board",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2020",
  jsx: "automatic",
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"' },
  loader: { ".woff2": "file", ".svg": "dataurl", ".png": "dataurl" },
  conditions: ["production"],
  logLevel: "info",
});
// Fonts load lazily from EXCALIDRAW_ASSET_PATH; skip the 12 MB Chinese fallback.
cpSync(join(pkg, "dist/prod/fonts"), join(out, "fonts"), {
  recursive: true,
  filter: (src) => !src.includes("Xiaolai"),
});
copyFileSync(join(here, "node_modules/react/LICENSE"), join(out, "react.LICENSE"));
copyFileSync(join(here, "LICENSES.md"), join(out, "LICENSES.md"));
