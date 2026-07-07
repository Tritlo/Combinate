#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

import * as boot from "./scenarios/boot.mjs";
import * as iotaIota from "./scenarios/iota-iota.mjs";
import * as cadenceMedium from "./scenarios/cadence-medium.mjs";
import * as grindLarge from "./scenarios/grind-large.mjs";
import * as recordPipeline from "./scenarios/record-pipeline.mjs";
import * as bundle from "./scenarios/bundle.mjs";

const execFileP = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const scenarios = [boot, iotaIota, cadenceMedium, grindLarge, recordPipeline, bundle];
const RUNS = 3;

const args = parseArgs(process.argv.slice(2));
const selected = scenarios.filter((scenario) => !args.scenario || scenario.name === args.scenario);
if (selected.length === 0) {
  console.error(`unknown scenario: ${args.scenario}`);
  console.error(`known scenarios: ${scenarios.map((scenario) => scenario.name).join(", ")}`);
  process.exit(2);
}

let vite = null;
let browser = null;
let baseUrl = null;
const results = {};
const errors = [];

try {
  const commit = await git(["rev-parse", "--short", "HEAD"]);
  const timestamp = await git(["show", "-s", "--format=%cI", "HEAD"]);
  const browserScenarios = selected.filter((scenario) => scenario.browser);
  const nodeScenarios = selected.filter((scenario) => !scenario.browser);

  if (browserScenarios.length > 0) {
    const port = await freePort();
    vite = await startVite(port);
    baseUrl = `http://127.0.0.1:${port}/`;
    browser = await chromium.launch({
      executablePath: await chromiumExecutable(),
      headless: true,
      args: ["--no-sandbox"],
    });

    for (const scenario of browserScenarios) {
      results[scenario.name] = await runScenario(scenario, async () => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
        await context.addInitScript((optimizeState) => {
          localStorage.setItem("combinate.helpSeen", "1");
          localStorage.setItem("combinate.showControls", "0");
          localStorage.removeItem("combinate:discovered:v1");
          localStorage.removeItem("combinate:v1:definitions");
          if (optimizeState) localStorage.setItem("combinate:optimize:v1", JSON.stringify(optimizeState));
          else localStorage.removeItem("combinate:optimize:v1");
        }, scenario.optimizeState ?? null);
        const page = await context.newPage();
        const pageErrors = [];
        page.on("pageerror", (err) => pageErrors.push(err.message || String(err)));
        try {
          const metrics = await scenario.run(page, contextForScenario());
          if (pageErrors.length > 0) throw new Error(`page error: ${pageErrors.join("; ")}`);
          return metrics;
        } finally {
          await context.close().catch(() => {});
        }
      });
    }

    await browser.close();
    browser = null;
    await stopVite(vite);
    vite = null;
  }

  for (const scenario of nodeScenarios) {
    results[scenario.name] = await runScenario(scenario, () => scenario.run(null, contextForScenario()));
  }

  const report = {
    timestamp,
    commit,
    scenarios: results,
  };

  printTable(results);
  if (args.json) {
    await mkdir(resolve(args.json, ".."), { recursive: true });
    await writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`);
  }

  for (const [name, result] of Object.entries(results)) {
    if (result.error) errors.push(`${name}: ${result.error}`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (vite) await stopVite(vite).catch(() => {});
}

if (errors.length > 0) {
  console.error("");
  for (const error of errors) console.error(error);
  process.exit(1);
}

function contextForScenario() {
  return {
    root,
    noBuild: args.noBuild,
    url({ path = "", search = "", hash = "" } = {}) {
      const u = new URL(path, baseUrl);
      if (search) u.search = search.startsWith("?") ? search : `?${search}`;
      if (hash) u.hash = hash.startsWith("#") ? hash : `#${hash}`;
      return u.href;
    },
  };
}

async function runScenario(scenario, runOne) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      runs.push(await runOne());
    } catch (err) {
      return {
        error: err instanceof Error && err.message ? err.message : String(err),
        runs,
      };
    }
  }
  return {
    runs,
    metrics: summarizeRuns(runs),
  };
}

function summarizeRuns(runs) {
  const keys = new Set();
  for (const run of runs) {
    for (const [key, value] of Object.entries(run)) {
      if (typeof value === "number" && Number.isFinite(value)) keys.add(key);
    }
  }
  const out = {};
  for (const key of keys) {
    const values = runs.map((run) => run[key]).filter((value) => typeof value === "number" && Number.isFinite(value));
    if (values.length === 0) continue;
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    out[key] = {
      median: values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2,
      min: values[0],
      max: values[values.length - 1],
    };
  }
  return out;
}

function printTable(results) {
  const rows = [["scenario", "metric", "median", "min", "max"]];
  for (const scenario of scenarios) {
    const result = results[scenario.name];
    if (!result) continue;
    if (result.error) {
      rows.push([scenario.name, "ERROR", result.error, "", ""]);
      continue;
    }
    if (result.runs?.[0]?.skipped) {
      rows.push([scenario.name, "skipped", result.runs[0].skipped, "", ""]);
      continue;
    }
    for (const [metric, stats] of Object.entries(result.metrics ?? {})) {
      rows.push([scenario.name, metric, fmt(stats.median), fmt(stats.min), fmt(stats.max)]);
    }
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => String(row[i] ?? "").length)));
  for (const row of rows) {
    console.log(row.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  "));
  }
}

function fmt(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "number") return String(value);
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 100) return value.toFixed(1);
  if (Math.abs(value) >= 10) return value.toFixed(2);
  return value.toFixed(3);
}

function parseArgs(argv) {
  const out = { json: null, scenario: null, noBuild: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") out.json = argv[++i];
    else if (arg.startsWith("--json=")) out.json = arg.slice("--json=".length);
    else if (arg === "--scenario") out.scenario = argv[++i];
    else if (arg.startsWith("--scenario=")) out.scenario = arg.slice("--scenario=".length);
    else if (arg === "--no-build") out.noBuild = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/perf/run.mjs [--json out.json] [--scenario name] [--no-build]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

async function git(args) {
  return (await execFileP("git", args, { cwd: root })).stdout.trim();
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function startVite(port) {
  const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    log += chunk.toString();
  });
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) log += `\nvite exited with ${code}`;
    else if (signal) log += `\nvite exited by ${signal}`;
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(log || "vite exited before becoming ready");
    if (await canFetch(`http://127.0.0.1:${port}/`)) return child;
    await sleep(100);
  }
  throw new Error(`vite did not become ready on ${port}\n${log}`);
}

async function canFetch(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function stopVite(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null) return;
    await sleep(100);
  }
  child.kill("SIGKILL");
}

async function chromiumExecutable() {
  const base = join(homedir(), ".cache", "ms-playwright");
  const candidates = [];
  await walk(base, (path) => {
    if (/chrome-linux(?:64)?\/chrome$/.test(path) && existsSync(path)) candidates.push(path);
  });
  candidates.sort();
  const found = candidates.at(-1);
  if (!found) throw new Error(`no Playwright Chromium executable found under ${base}`);
  return found;
}

async function walk(dir, visit) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, visit);
    else if (entry.isFile()) visit(path);
  }
}
