import { test, expect } from "@playwright/test";

async function mockServices(page, kind = "company_user", role = "owner", needsPassword = true, activeCompany = false) {
  const user = { id: "10000000-0000-4000-8000-000000000001", email: "fixture@example.test", aud: "authenticated", role: "authenticated", app_metadata: { force_password_reset: needsPassword }, user_metadata: {}, created_at: new Date().toISOString() };
  const token = [Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"), Buffer.from(JSON.stringify({ sub: user.id, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now()/1000)+3600, iat: Math.floor(Date.now()/1000) })).toString("base64url"), Buffer.from("fixture-signature").toString("base64url")].join(".");
  let passwordWrites = 0;
  let accepted = false;
  await page.route("https://fonts.googleapis.com/**", route => route.abort());
  await page.route("https://fonts.gstatic.com/**", route => route.abort());
  await page.route("**/api/config", route => route.fulfill({ json: { url: "https://auth.example.test", anonKey: "fixture-public-key" } }));
  await page.route("https://auth.example.test/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/user")) {
      if (route.request().method() === "PUT") { passwordWrites++; }
      return route.fulfill({ json: user });
    }
    if (path.endsWith("/token")) return route.fulfill({ json: { access_token: token, refresh_token: "fixture-refresh", expires_in: 3600, token_type: "bearer", user } });
    if (path.endsWith("/logout")) return route.fulfill({ json: {} });
    throw new Error(`Unexpected Auth request: ${path}`);
  });
  await page.route("**/api/session", route => route.fulfill({ json: { kind, role, userId: user.id, status: activeCompany ? "active" : "pending", memberStatus: activeCompany ? "active" : "invited", organizationId: "fixture-org", organizationName: "Fixture company" } }));
  await page.route("**/api/auth/complete-password-reset", async route => {
    expect(route.request().postDataJSON().password).toBe("A-strong-fixture-password-123!");
    passwordWrites++; user.app_metadata.force_password_reset = false;
    return route.fulfill({ json: { completed: true } });
  });
  await page.route("**/api/org/accept-invitation", route => { accepted = true; return route.fulfill({ json: { accepted: [], pendingActivation: true } }); });
  return { fragment: `#access_token=${token}&refresh_token=fixture-refresh&type=${needsPassword ? "invite" : "magiclink"}`, passwordWrites: () => passwordWrites, accepted: () => accepted };
}

for (const portal of ["/admin/login", "/super-admin/login"]) {
  test(`restored company session is redirected to its portal from ${portal}`, async ({page}) => {
    const fixture = await mockServices(page, "company_user", "owner", false, true);
    await page.goto(`${portal}${fixture.fragment}`);
    await expect(page.getByRole("heading", {name:"Use your company portal"})).toBeVisible();
    await expect(page.getByRole("link", {name:"Continue to company login"})).toHaveAttribute("href", "/login");
    await expect(page.getByRole("button", {name:"Record",exact:true})).toHaveCount(0);
  });
}

test("company invitation opens password creation, accepts membership, then shows login", async ({page}) => {
  const fixture = await mockServices(page);
  await page.goto(`/auth/invite${fixture.fragment}`);
  await expect(page.getByLabel("Create password (12 characters minimum)")).toBeVisible();
  await expect(page).not.toHaveURL(/access_token/);
  await page.getByLabel("Create password (12 characters minimum)").fill("A-strong-fixture-password-123!");
  await page.getByRole("button", {name:"Set password and accept"}).click();
  await expect(page).toHaveURL(/\/login\?welcome=1$/);
  await expect(page.getByRole("button", {name:"Log In",exact:true})).toBeVisible();
  expect(fixture.passwordWrites()).toBe(1); expect(fixture.accepted()).toBe(true);
});

test("old admin invite routes are recovered and finish at the admin login", async ({page}) => {
  const fixture = await mockServices(page,"platform_admin","admin");
  await page.goto(`/admin/login${fixture.fragment}`);
  await expect(page).toHaveURL(/\/auth\/invite/);
  await page.getByLabel("Create password (12 characters minimum)").fill("A-strong-fixture-password-123!");
  await page.getByRole("button",{name:"Set password and accept"}).click();
  await expect(page).toHaveURL(/\/admin\/login\?welcome=1$/);
  expect(fixture.passwordWrites()).toBe(1); expect(fixture.accepted()).toBe(false);
});

test("Site URL fallback is recovered and super admins get their own login", async ({page}) => {
  const fixture = await mockServices(page,"platform_admin","super_admin");
  await page.goto(`/${fixture.fragment}`);
  await page.getByLabel("Create password (12 characters minimum)").fill("A-strong-fixture-password-123!");
  await page.getByRole("button",{name:"Set password and accept"}).click();
  await expect(page).toHaveURL(/\/super-admin\/login\?welcome=1$/);
});

test("existing members accept without changing their password", async ({page}) => {
  const fixture = await mockServices(page,"company_user","staff",false);
  await page.goto(`/auth/invite${fixture.fragment}`);
  await expect(page.getByText("Your password stays the same.",{exact:false})).toBeVisible();
  await page.getByRole("button",{name:"Accept invitation",exact:true}).click();
  await expect(page).toHaveURL(/\/login\?welcome=1$/);
  expect(fixture.passwordWrites()).toBe(0); expect(fixture.accepted()).toBe(true);
});

test("expired invitations explain how to recover without a password form", async ({page}) => {
  await mockServices(page);
  await page.goto("/auth/invite?error=access_denied&error_description=Email+link+is+invalid+or+has+expired");
  await expect(page.getByText(/This email link has expired/)).toBeVisible();
  await expect(page.getByLabel("Create password (12 characters minimum)")).toHaveCount(0);
});

test("company logout clears the session without a browser error", async ({page}) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const fixture = await mockServices(page, "company_user", "owner", false);
  await page.goto(`/login${fixture.fragment}`);
  await page.getByRole("button", {name:"Log Out",exact:true}).click();
  await expect(page.getByRole("button", {name:"Log In",exact:true})).toBeVisible();
  expect(await page.evaluate(async () => (await window.sbClient.auth.getSession()).data.session)).toBeNull();
  expect(errors).toEqual([]);
});
