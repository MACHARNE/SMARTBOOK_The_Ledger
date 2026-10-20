// Local static preview for browser checks. APIs are mocked by Playwright.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../dist");
http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const isPage = ["/", "/login", "/signup", "/auth/invite", "/auth/callback", "/admin/login", "/super-admin/login"].includes(url.pathname);
  const file = path.resolve(root, isPage ? "fb091d/index.html" : `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  fs.readFile(file, (error, bytes) => {
    if (error) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8" }); response.end(bytes);
  });
}).listen(4173, "127.0.0.1", () => console.log("Local preview: http://127.0.0.1:4173"));
