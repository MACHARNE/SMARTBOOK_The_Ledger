export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  return Response.json({ error: "Company signup is invitation-only. Ask your organization owner for an invitation." }, { status: 403 });
}
