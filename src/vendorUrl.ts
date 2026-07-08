/**
 * Resolve a path under `public/` to an absolute URL that respects the deploy base.
 *
 * Vite rewrites *bundled* imports for the configured base (`"./"`, so the SPA
 * hosts from any path — including GitHub Pages' `/Combinate/` subpath), but it does
 * NOT rewrite runtime-fetched public assets. The vendored wasm/blobs (DuckDB, the
 * MicroHs compiler dist + its base package) are fetched at runtime, so a bare
 * `/vendor/...` would 404 on a subpath deploy against the origin root. Resolving
 * `BASE_URL + path` against `document.baseURI` gives the right URL in both places:
 *   - dev (base `/`):   new URL("/vendor/x",  "http://host/")            → http://host/vendor/x
 *   - Pages (base `./`): new URL("./vendor/x", "https://u.gh.io/Combinate/") → …/Combinate/vendor/x
 *
 * The result is absolute, so it's also safe to hand to a Worker (which has no
 * `document` to resolve a relative URL against — the compile worker gets its
 * asset URLs this way via `postMessage`).
 */
export function vendorUrl(path: string): string {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return new URL(base + path, document.baseURI).href;
}
