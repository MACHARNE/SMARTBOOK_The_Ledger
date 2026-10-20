import type { IncomingMessage, ServerResponse } from "node:http";

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const protocol = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0];
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `${protocol}://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(url, { method: req.method, headers, body });
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const request = await toWebRequest(req);
    const url = new URL(request.url);
    const isConfigRoute = url.pathname === "/api/config" || url.searchParams.get("route") === "config";
    let response: Response;
    if (isConfigRoute) {
      const { default: config } = await import("../bk095d/api/config.js");
      response = config(request);
    } else {
      const { default: route } = await import("../bk095d/api/_router.js");
      response = await route(request);
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => { headers[name] = value; });
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, headers);
    res.end(body);
  } catch (error) {
    console.error("API initialization or request failed", error);
    res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "The request could not be completed. Please retry or contact support." }));
  }
}
