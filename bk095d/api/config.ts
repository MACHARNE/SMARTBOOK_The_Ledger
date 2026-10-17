export default function handler(_request: Request): Response {
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return Response.json({ error: "Authentication is not configured." }, { status: 503 });
  return Response.json({ url, anonKey: publishableKey }, { headers: { "Cache-Control": "no-store" } });
}
