// Assemble the GitHub Pages site for the browser/WASM app.
//
// wasm-app/ is already the browser build: index.html, app.js, styles, and
// vendor/cactus.{js,wasm}. There is no compile step. wasm-app/serve.ts only
// exists to download mirage.cact on first request; Pages has no server, so
// this script fetches the same weights into the published tree.
//
// Asset URLs in the app are relative. Resolving them against the project
// site (https://skyevasquez.github.io/mirage-demo/) must stay inside that
// subpath, which is what the checks below enforce.

import { mkdir, copyFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_URL =
  "https://huggingface.co/Cactus-Compute/mirage/resolve/main/mirage.cact";
const PAGES_BASE = "https://skyevasquez.github.io/mirage-demo/";
const PAGES_PREFIX = "/mirage-demo/";
const MIN_MODEL_BYTES = 1_000_000;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceDir = join(repoRoot, "wasm-app");
const outDir = join(repoRoot, "dist");

const STATIC_FILES = [
  "index.html",
  "styles.css",
  "app.js",
  ".nojekyll",
  "vendor/cactus.js",
  "vendor/cactus.wasm",
] as const;

// URLs the page actually requests. All of these must resolve under /mirage-demo/.
const ASSET_URLS = [
  "./styles.css",
  "./vendor/cactus.js",
  "./app.js",
  "./vendor/cactus.wasm",
  "./models/mirage.cact",
] as const;

function pagesRelativePath(assetUrl: string): string {
  const pathname = new URL(assetUrl, PAGES_BASE).pathname;
  if (!pathname.startsWith(PAGES_PREFIX)) {
    throw new Error(
      `${assetUrl} resolves to ${pathname}, which is outside ${PAGES_PREFIX}`,
    );
  }
  return decodeURIComponent(pathname.slice(PAGES_PREFIX.length));
}

function assertNoRootAbsoluteAssets(label: string, source: string): void {
  const rootAbsolute = /(?:src|href)\s*=\s*["']\/(?!\/)/;
  const rootFetch = /["'`]\/(?:vendor|models|app\.js|styles\.css)/;
  if (rootAbsolute.test(source) || rootFetch.test(source)) {
    throw new Error(
      `${label} uses a root-absolute asset URL. Relative URLs are required so the site works at ${PAGES_PREFIX}`,
    );
  }
}

async function copyStaticFiles(): Promise<void> {
  await mkdir(join(outDir, "vendor"), { recursive: true });
  await mkdir(join(outDir, "models"), { recursive: true });
  for (const rel of STATIC_FILES) {
    const from = join(sourceDir, rel);
    const to = join(outDir, rel);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

async function downloadModel(): Promise<void> {
  const dest = join(outDir, "models", "mirage.cact");
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(MODEL_URL, { redirect: "follow" });
      if (!res.ok) {
        throw new Error(`model download failed: HTTP ${res.status}`);
      }
      await Bun.write(dest, res);
      const size = (await stat(dest)).size;
      if (size < MIN_MODEL_BYTES) {
        throw new Error(`mirage.cact is only ${size} bytes`);
      }
      console.log(`mirage.cact ${size} bytes`);
      return;
    } catch (err) {
      lastError = err;
      console.warn(`model download attempt ${attempt} failed: ${err}`);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("model download failed");
}

async function validateWasm(): Promise<void> {
  const wasmPath = join(outDir, "vendor", "cactus.wasm");
  const bytes = new Uint8Array(await Bun.file(wasmPath).arrayBuffer());
  const magic = [0x00, 0x61, 0x73, 0x6d];
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) {
      throw new Error("vendor/cactus.wasm is not a WebAssembly binary");
    }
  }
  await WebAssembly.compile(bytes);
  console.log(`cactus.wasm ${bytes.byteLength} bytes, compile ok`);
}

async function validateSubpath(): Promise<void> {
  const html = await Bun.file(join(outDir, "index.html")).text();
  const js = await Bun.file(join(outDir, "app.js")).text();
  const published = `${html}\n${js}`;
  assertNoRootAbsoluteAssets("index.html", html);
  assertNoRootAbsoluteAssets("app.js", js);

  for (const assetUrl of ASSET_URLS) {
    if (!published.includes(assetUrl)) {
      throw new Error(`${assetUrl} is not referenced by the published app`);
    }
    const rel = pagesRelativePath(assetUrl);
    const file = join(outDir, rel);
    const info = await stat(file);
    if (!info.isFile() || info.size === 0) {
      throw new Error(`${assetUrl} did not produce a file at dist/${rel}`);
    }
  }

  const nojekyll = await stat(join(outDir, ".nojekyll"));
  if (!nojekyll.isFile()) {
    throw new Error("dist/.nojekyll is missing");
  }
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const marker = join(sourceDir, ".nojekyll");
  try {
    await stat(marker);
  } catch {
    await writeFile(
      marker,
      "GitHub Pages: serve this directory as plain static files (no Jekyll).\n",
    );
  }
  await copyStaticFiles();
  await downloadModel();
  await validateWasm();
  await validateSubpath();
  console.log(`Pages site written to ${outDir}`);
}

await main();
