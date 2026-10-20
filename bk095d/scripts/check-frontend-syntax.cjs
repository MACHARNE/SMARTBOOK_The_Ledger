const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("@babel/parser");

const directory = path.resolve(__dirname, "../../fb091d");
for (const file of fs.readdirSync(directory).filter(file => /\.(jsx|js)$/.test(file))) {
  parse(fs.readFileSync(path.join(directory, file), "utf8"), { sourceType: "module", plugins: ["jsx"] });
}
console.log("Frontend React/JSX syntax is valid.");
