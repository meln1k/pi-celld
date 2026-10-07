import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { assets } from "./app/assets.ts";

try {
  const entries = (await assets.getAssets()).flatMap(({ type, filePath }) =>
    type === "script" && filePath &&
      relative(Deno.cwd(), filePath).startsWith("app/")
      ? [filePath]
      : []
  );
  const entryPoints = Object.fromEntries(entries.map((filePath) => [
    relative(Deno.cwd(), filePath).replace(/\.[^.]+$/, ""),
    filePath,
  ]));
  await build({
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    jsxImportSource: "remix/component",
    define: { "process.env.NODE_ENV": '"production"' },
    entryPoints,
    outdir: "dist/public/assets",
    splitting: true,
    minify: true,
  });

  const hrefs = Object.fromEntries(entries.flatMap((filePath) => {
    const source = relative(Deno.cwd(), filePath);
    const href = `/assets/${source.replace(/\.[^.]+$/, ".js")}`;
    return [[source, href], [pathToFileURL(filePath).href, href]];
  }));
  // The Worker uses build-time metadata, never the filesystem-backed compiler.
  const assetModule = `
    const hrefs = ${JSON.stringify(hrefs)};
    export const assets = {
      async getScriptEntry(id) {
        const href = hrefs[id.split('#')[0]];
        if (!href) throw new Error('Unknown client entry: ' + id);
        return { href, importMap: { imports: {} }, preloads: [] };
      },
      async fetch() { return null; }
    };
    export const scriptEntry = await assets.getScriptEntry('app/actions/public/entry.ts');
  `;
  await build({
    entryPoints: ["worker.ts"],
    outfile: "dist/worker.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    keepNames: true,
    jsx: "automatic",
    jsxImportSource: "remix/component",
    define: { "process.env.NODE_ENV": '"production"' },
    external: ["cloudflare:workers", "node:*"],
    loader: { ".sql": "text" },
    plugins: [{
      name: "remix-assets",
      setup(build) {
        build.onLoad({ filter: /\/app\/assets\.ts$/ }, () => ({
          contents: assetModule,
          loader: "ts",
        }));
        build.onLoad({ filter: /\.[jt]sx?$/ }, async ({ path }) => {
          if (!entries.includes(path)) return;
          return {
            contents: (await readFile(path, "utf8")).replaceAll(
              "import.meta.url",
              JSON.stringify(pathToFileURL(path).href),
            ),
            loader: path.endsWith(".tsx") ? "tsx" : "ts",
            resolveDir: resolve(path, ".."),
          };
        });
      },
    }],
  });
} finally {
  await assets.close();
  stop();
}
