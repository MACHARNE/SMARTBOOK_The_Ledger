const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, "dist");
const publicDir = path.join(outputDir, "fb091d");

if (outputDir !== path.join(root, "dist")) {
  throw new Error("Refusing to clean an unexpected output directory.");
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(publicDir, { recursive: true });

for (const file of ["index.html", "storage-adapter.js"]) {
  fs.copyFileSync(path.join(root, "fb091d", file), path.join(publicDir, file));
}

esbuild.buildSync({
  absWorkingDir: root,
  entryPoints: ["fb091d/app.jsx"],
  outfile: "dist/fb091d/app.js",
  bundle: true,
  minify: true,
  platform: "browser",
  format: "esm",
  target: ["es2020"],
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  legalComments: "none",
});

console.log("Built the Smart Book frontend in dist/fb091d.");
