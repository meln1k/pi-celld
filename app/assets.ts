import { createAssetServer } from "remix/assets";

export const assets = createAssetServer({
  basePath: "/assets",
  rootDir: Deno.cwd(),
  allowFiles: ["app/routes.ts", "app/**/public/**"],
  allowPackages: ["remix"],
  denyFiles: ["app/**/*.test.*"],
  minify: true,
});

export const scriptEntry = await assets.getScriptEntry(
  "app/actions/public/entry.ts",
);
