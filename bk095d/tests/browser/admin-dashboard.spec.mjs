import { test, expect } from "@playwright/test";
import { mockAdminWorkspace } from "./admin-fixtures.mjs";
const nav = (page, name) => page.getByRole("navigation", { name: "Platform navigation" }).getByRole("button", { name, exact: true });

test("super admin overview uses real response counts and clear navigation", async ({ page }) => {
  const fixture = await mockAdminWorkspace(page); await fixture.goto();
  await expect(page.getByRole("heading", { name: "Workspace overview" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Total companies/ })).toContainText("43");
  await expect(nav(page, "Administrators")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("platform admin has monitoring views without privileged controls", async ({ page }) => {
  const fixture = await mockAdminWorkspace(page, "admin"); await fixture.goto();
  await expect(page.getByText("You have monitoring access.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite company", exact: true })).toHaveCount(0);
  await expect(nav(page, "Administrators")).toHaveCount(0);
  await nav(page, "Companies").click(); await page.getByRole("button", { name: "View company", exact: false }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve company|Suspend company|Download Excel|Set trial/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await nav(page, "Your access").click(); await expect(page.getByRole("heading", { name: "Platform admin permissions" })).toBeVisible();
  expect(fixture.calls.filter(call => call.path === "/api/admin/administrators")).toHaveLength(0);
});
test("company search, status filters and pagination are server driven", async ({ page }) => {
  const fixture = await mockAdminWorkspace(page); await fixture.goto("companies");
  await expect(page.getByText("1–20 of 43 companies")).toBeVisible();
  await page.getByRole("button", { name: "Next companies page" }).click();
  await expect(page.getByText("21–40 of 43 companies")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search companies" }).fill("North Star");
  await expect(page.getByText("1–1 of 1 companies")).toBeVisible();
  await expect(page.getByRole("cell", { name: /North Star Logistics/ })).toBeVisible();
  await page.getByLabel("Company status").selectOption("active");
  await expect(page.getByRole("heading", { name: "No matching companies" })).toBeVisible();
  expect(fixture.calls.some(call => call.query.includes("page=1"))).toBe(true);
});
test("trial summary opens only active companies with trials ending in seven days", async ({ page }) => {
  const fixture = await mockAdminWorkspace(page); await fixture.goto();
  await page.getByRole("button", { name: /Trials ending soon/ }).click();
  await expect(page.getByLabel("Company status")).toHaveValue("trial_ending");
  await expect(page.getByText("1–2 of 2 companies")).toBeVisible();
  await expect(page.getByRole("cell", { name: /Example Retail/ })).toBeVisible();
});
test("reject requires a reason and sends only one confirmed decision", async ({ page }) => {
  const fixture = await mockAdminWorkspace(page, "super_admin", { holdPath: "/api/admin/decision" }); await fixture.goto("approvals");
  await page.getByRole("button", { name: "Review request", exact: false }).first().click();
  await page.getByRole("button", { name: "Reject request", exact: true }).click();
  const reason = page.getByRole("textbox", { name: "Reason", exact: true });
  await page.getByRole("button", { name: "Confirm rejection", exact: true }).click();
  expect(fixture.posts).toHaveLength(0);
  await reason.fill("Company details could not be verified.");
  await page.getByRole("button", { name: "Confirm rejection", exact: true }).click();
  await expect.poll(() => fixture.posts.length).toBe(1);
  await expect(page.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeVisible();
  fixture.release(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Action completed" })).toContainText("company request rejected");
  expect(fixture.posts[0].body.reason).toBe("Company details could not be verified.");
});
test("failed admin save preserves form values and supports a clear retry", async ({ page }) => {
  const fixture = await mockAdminWorkspace(page); await fixture.goto(); fixture.failNext("/api/admin/org/provision-owner", "Email delivery is unavailable. Retry to send the invitation.");
  await page.getByRole("button", { name: "Invite company", exact: true }).click();
  await page.getByRole("textbox", { name: "Company name", exact: true }).fill("New Company");
  await page.getByRole("textbox", { name: "Owner’s name", exact: true }).fill("Sample Owner");
  await page.getByRole("textbox", { name: "Owner’s email", exact: true }).fill("new@example.test");
  await page.getByRole("button", { name: "Send company invitation", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Email delivery is unavailable");
  await expect(page.getByRole("textbox", { name: "Company name", exact: true })).toHaveValue("New Company");
  await page.getByRole("button", { name: "Send company invitation", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByRole("status", { name: "Action completed" })).toContainText("Invitation sent to new@example.test");
});
test("decision history shows completed decisions and their reasons", async ({ page }) => {
  const fixture = await mockAdminWorkspace(page); await fixture.goto("approvals");
  await page.getByRole("button", { name: "Decision history", exact: true }).click();
  await page.getByLabel("Decision status").selectOption("rejected");
  await page.getByRole("button", { name: "View details", exact: false }).first().click();
  await expect(page.getByText("Company details could not be verified.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve company", exact: true })).toHaveCount(0);
});
test("administrator role and access changes require an explicit dialog", async ({ page }) => {
  const fixture = await mockAdminWorkspace(page); await fixture.goto("administrators");
  const own = page.getByRole("row").filter({ hasText: "paul@example.test" }); await expect(own.getByRole("button")).toHaveCount(0);
  const support = page.getByRole("row").filter({ hasText: "support@example.test" }); await support.getByRole("button", { name: "Change role", exact: true }).click();
  await page.getByLabel("New role").selectOption("super_admin"); await page.getByRole("button", { name: "Update administrator role", exact: true }).click();
  await expect(page.getByRole("status", { name: "Action completed" })).toContainText("Administrator role updated");
  await support.getByRole("button", { name: "Remove access", exact: true }).click();
  await page.getByRole("button", { name: "Remove platform access", exact: true }).click();
  expect(fixture.posts.filter(p => p.body.action === "revoke")).toHaveLength(0);
  await page.getByRole("textbox", { name: "Reason", exact: true }).fill("Team member has left.");
  await page.getByRole("button", { name: "Remove platform access", exact: true }).click();
  await expect(page.getByRole("status", { name: "Action completed" })).toContainText("Platform access removed");
  await expect(page.getByRole("cell", { name: /support@example.test/ })).toHaveCount(0);
});
test("activity filters retain a readable decision trail", async ({ page }) => {
  const fixture = await mockAdminWorkspace(page); await fixture.goto("activity");
  await page.getByLabel("Activity type").selectOption("suspend");
  await expect(page.getByRole("strong").filter({ hasText: /^Company suspended$/ })).toBeVisible();
  await expect(page.getByText("Requested by the company owner.", { exact: true })).toBeVisible();
  await expect(page.getByRole("strong").filter({ hasText: /^Company activated$/ })).toHaveCount(0);
});
test("read failures show retry rather than an empty successful list", async ({ page }) => {
  const fixture = await mockAdminWorkspace(page); fixture.failNext("/api/admin/organizations"); await fixture.goto("companies");
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(page.getByRole("heading", { name: "No matching companies" })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("1–20 of 43 companies")).toBeVisible();
});
test("mobile workspace and company dialog fit the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const fixture = await mockAdminWorkspace(page); await fixture.goto();
  for (const section of ["Companies", "Approvals", "Administrators", "Activity log", "Overview"]) { await nav(page, section).click(); await expect(page.locator("h1")).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }
  await page.getByRole("button", { name: "Invite company", exact: true }).click(); await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.getByRole("dialog").evaluate(element => element.getBoundingClientRect().width <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
});
