const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("@babel/parser");

const htmlPath = path.resolve(__dirname, "../../fb091d/index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const match = html.match(/<script\s+type="text\/babel"[^>]*>([\s\S]*?)<\/script>/i);
if (!match) throw new Error("Could not find the embedded React/Babel application script.");
parse(match[1], { sourceType: "script", plugins: ["jsx"] });
console.log("Embedded React/JSX syntax is valid.");
