import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const name = "bundle";
export const browser = false;

export async function run(_page, ctx) {
  if (ctx.noBuild) return { skipped: "no-build" };

  const start = performance.now();
  await execFileP("npm", ["run", "build"], {
    cwd: ctx.root,
    maxBuffer: 1024 * 1024 * 16,
  });
  const build_ms = performance.now() - start;

  const files = await jsFiles(join(ctx.root, "dist"));
  if (files.length === 0) throw new Error("bundle: dist contains no JS files");

  const indexHtml = await readFile(join(ctx.root, "dist", "index.html"), "utf8").catch(() => "");
  const mainMatch = indexHtml.match(/<script[^>]+type="module"[^>]+src="\.?\/?([^"]+\.js)"/);
  const mainPath = mainMatch ? join(ctx.root, "dist", mainMatch[1]) : largest(files).path;
  const main = await fileBytes(mainPath);

  let total_js_bytes = 0;
  let total_js_gzip_bytes = 0;
  for (const file of files) {
    const bytes = await fileBytes(file.path);
    total_js_bytes += bytes.raw;
    total_js_gzip_bytes += bytes.gzip;
  }

  return {
    build_ms,
    main_js_bytes: main.raw,
    main_js_gzip_bytes: main.gzip,
    total_js_bytes,
    total_js_gzip_bytes,
    js_files: files.length,
  };
}

async function jsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await jsFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      const s = await stat(path);
      out.push({ path, size: s.size });
    }
  }
  return out;
}

async function fileBytes(path) {
  const buf = await readFile(path);
  return { raw: buf.length, gzip: gzipSync(buf).length };
}

function largest(files) {
  return files.reduce((best, file) => (file.size > best.size ? file : best), files[0]);
}
