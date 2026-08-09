#!/usr/bin/env node
/**
 * Builds a self-contained preview.html from the Vite output + a captured
 * /api/status payload, so the dashboard can be viewed/embedded without a
 * running server. Usage:
 *
 *   node make-preview.cjs [status.json]
 *
 * The status JSON defaults to ./snapshot.json if present.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const payloadFile = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'snapshot.json');

const htmlPath = path.join(ROOT, 'dist', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const asset = (re) => {
  const m = html.match(re);
  if (!m) throw new Error(`asset not found: ${re}`);
  return path.join(ROOT, 'dist', 'assets', m[1]);
};

const cssFile = asset(/assets\/(index-[^"]+\.css)/);
const jsFile = asset(/assets\/(index-[^"]+\.js)/);
const css = fs.readFileSync(cssFile, 'utf8');
const js = fs.readFileSync(jsFile, 'utf8');

let payload = null;
if (fs.existsSync(payloadFile)) {
  payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
}

let out = html;
out = out.replace(
  /<link rel="stylesheet"[^>]*>|<link[^>]*stylesheet[^>]*>/,
  () => `<style>\n${css}\n</style>`
);
out = out.replace(
  /<script type="module"[^>]*>.*?<\/script>/s,
  () =>
    `<script>window.__EMBEDDED_STATUS__ = ${JSON.stringify(payload)};</script>\n` +
    `<script type="module">\n${js}\n</script>`
);

const outPath = path.join(ROOT, 'preview.html');
fs.writeFileSync(outPath, out);
console.log(`wrote ${outPath} (${(out.length / 1024).toFixed(0)} kB, payload ${payload ? 'embedded' : 'none'})`);
