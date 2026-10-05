import type { Handle, RemixNode } from "remix/component";
import { ImportMap } from "remix/component/server";
import { scriptEntry } from "../assets.ts";

export interface DocumentProps {
  children?: RemixNode;
  head?: RemixNode;
  title?: string;
}

export function Document(handle: Handle<DocumentProps>) {
  return () => {
    let { children, head, title = "Pi Celld" } = handle.props;
    const { href, importMap, preloads } = scriptEntry;

    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <link rel="stylesheet" href="/styles.css" />
          <title>{title}</title>
          {head}
          <ImportMap value={importMap} />
          {preloads.map((href) => <link key={href} rel="modulepreload" href={href} />)}
          <script type="module" src={href}></script>
        </head>
        <body>{children}</body>
      </html>
    );
  };
}
