// Builds sw.js from the template: the list of files to precache + a version that changes with their content.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/** @param {string} outDir built site folder; writes <outDir>/sw.js */
export function makeSw(outDir, templatePath) {
  const skip = new Set(["sw.js", "_redirects"]);
  const files = walk(outDir).filter((f) => !skip.has(f));
  const hash = crypto.createHash("sha1");
  for (const f of files.sort()) {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(outDir, f)));
  }
  const version = hash.digest("hex").slice(0, 10);
  const precache = ["./", ...files];
  const tpl = fs.readFileSync(templatePath, "utf8");
  fs.writeFileSync(path.join(outDir, "sw.js"), tpl.replace("__VERSION__", version).replace("__PRECACHE__", JSON.stringify(precache, null, 2)));
  return { version, count: precache.length };
}
