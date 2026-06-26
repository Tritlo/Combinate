// Generate the prewarmed Prelude cache for the live MicroHs compiler:
//   public/vendor/mhs/base.mhscache   (git-ignored, vendored alongside the blob)
//
//   node scripts/gen-mhs-cache.mjs
//
// Only the blob's eval runtime can write a .mhscache (serialization is absent from
// the GHC build), so we run the vendored mhs-batch.js once in a headless browser,
// compiling a Prelude-heavy program with -CW, then extract the cache. The live
// worker then reads it with -CR, halving the compile time (~65s -> ~30s).
// Needs public/vendor/mhs/mhs-batch.js (build with nix/build-wasm.sh).
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, extname } from "node:path";
import { existsSync } from "node:fs";

if (!existsSync("public/vendor/mhs/mhs-batch.js")) {
  console.error("public/vendor/mhs/mhs-batch.js missing — build it first: nix-shell nix/shell.nix --run ./nix/build-wasm.sh");
  process.exit(1);
}

const MIME = { ".js": "text/javascript", ".wasm": "application/wasm", ".mhscache": "application/octet-stream", ".comb": "text/plain" };
const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (url === "/") return void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><html><body></body></html>");
  try {
    const data = await readFile(join("public", url));
    res.writeHead(200, { "content-type": MIME[extname(url)] || "application/octet-stream" }).end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

const exec = ["chromium-1208", "chromium-1200"]
  .flatMap((d) => ["chrome-linux64/chrome", "chrome-linux/chrome"].map((b) => join(homedir(), ".cache/ms-playwright", d, b)))
  .find(existsSync);
const browser = await chromium.launch({ executablePath: exec, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto(origin + "/", { waitUntil: "domcontentloaded" });

console.log("compiling a Prelude-heavy program with -CW (cold, ~1 min)...");
const r = await page.evaluate((blobUrl) => {
  // Importing Prelude (implicit) + Data.List + Data.Char pulls in the bulk of base
  // transitively, so the cache covers most programs. Keep it small — a broader
  // warm-up compiles too slowly cold to bootstrap (>3 min).
  const source =
    "module Ex(out) where\nimport Data.List\nimport Data.Char\nout :: [Int]\nout = map (\\x -> x + 1) (reverse [1,2,3])\n";
  const src = String.raw`
    let cap="", ce="", reported=false; const t0=Date.now();
    function b64(b){ let s=""; const C=8192; for(let i=0;i<b.length;i+=C) s+=String.fromCharCode.apply(null,b.subarray(i,i+C)); return btoa(s); }
    function report(extra){ if(reported)return; reported=true;
      let cb=null,sz=-1; try{ const c=self.Module.FS.readFile("/.mhscache"); sz=c.length; cb=b64(c);}catch(e){sz="ERR "+e.message;}
      self.postMessage(Object.assign({ ms:Date.now()-t0, hasDump:cap.includes(" = "), size:sz, cb }, extra||{})); }
    self.Module = {
      arguments: ["-CW","-ddump-combinator","-i.","-i/lib","Ex"],
      print:(t)=>{cap+=t+"\n";}, printErr:(t)=>{ce+=t+"\n";},
      preRun:[function(){ self.Module.FS.writeFile("Ex.hs", ${JSON.stringify(source)}); }],
      postRun:[function(){report({});}], onExit:function(){report({});}, onAbort:function(x){report({abort:String(x).slice(0,150)});},
    };
    try { importScripts(${JSON.stringify(blobUrl)}); } catch(e){ report({loadError:String(e)}); }
  `;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  return new Promise((res) => { w.onmessage=(e)=>res(e.data); w.onerror=(e)=>res({workerError:e.message}); setTimeout(()=>res({timeout:true}),200000); });
}, origin + "/vendor/mhs/mhs-batch.js");

await browser.close();
server.close();

if (!r.cb || !r.hasDump) {
  console.error(`failed: ${JSON.stringify({ ...r, cb: r.cb ? "[" + r.cb.length + "]" : null })}`);
  process.exit(1);
}
await writeFile("public/vendor/mhs/base.mhscache", Buffer.from(r.cb, "base64"));
console.log(`wrote public/vendor/mhs/base.mhscache (${(r.size / 1024).toFixed(0)} KB) in ${(r.ms / 1000).toFixed(0)}s`);
