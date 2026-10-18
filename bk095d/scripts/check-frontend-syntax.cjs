const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("@babel/parser");

const sourcePath = path.resolve(__dirname, "../../fb091d/app.jsx");
const source = fs.readFileSync(sourcePath, "utf8");
parse(source, { sourceType: "module", plugins: ["jsx"] });
console.log("Frontend React/JSX syntax is valid.");
