export function authRedirect(request: Request, path = "/auth/invite"): string {
  const configured = process.env.AUTH_EMAIL_REDIRECT_URL || process.env.APP_URL;
  const url = new URL(configured || request.url);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("A secure application URL is required for email links.");
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}
