import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { assets } from "./app/assets.ts";

const sourceDir = await Deno.makeTempDir({ dir: "dist" });
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
  // Prepare Remix's Worker metadata without modifying application sources.
  await cp("app", `${sourceDir}/app`, { recursive: true });
  await cp("worker.ts", `${sourceDir}/worker.ts`);
  await writeFile(`${sourceDir}/app/assets.ts`, assetModule);
  for (const path of entries) {
    await writeFile(
      `${sourceDir}/${relative(Deno.cwd(), path)}`,
      (await readFile(path, "utf8")).replaceAll(
        "import.meta.url",
        JSON.stringify(pathToFileURL(path).href),
      ),
    );
  }
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--frozen",
      "--config",
      resolve("deno.json"),
      "--platform",
      "browser",
      "--keep-names",
      "--external",
      "cloudflare:workers",
      "--external",
      "node:zlib",
      "--output",
      "dist/worker.js",
      `${sourceDir}/worker.ts`,
    ],
    env: { NODE_ENV: "production" },
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error("Worker bundle failed");
} finally {
  await rm(sourceDir, { recursive: true, force: true });
  await assets.close();
  stop();
}
