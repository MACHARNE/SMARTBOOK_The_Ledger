# Smart Book — Backend Implementation Brief

Build the production backend for the Smart Book app in this Git project using TypeScript on Node.js Vercel Functions. Deploy from Git to Vercel and use Supabase for authentication and the Postgres database. Express is not part of the initial stack unless later requirements justify a persistent/custom API server.

## Login portals and company activation

Implement two distinct entry points in the same deployment:

- `/super-admin/login`: private platform super-admin sign-in. Do not provide public super-admin signup, shared credentials, or a hard-coded password. Provision the initial named super-admin through a secure operator process. Protect admin pages and operations with server/database authorization, not just frontend route checks.
- `/signup` and `/login`: invitation acceptance and normal company-user login. Company signup is invitation-only: a super admin creates the pending organization and invites its owner. Public visitors cannot create a company request or membership.

Required flow:

1. Super admin enters company details, creates a `pending` organization and approval request, and invites its owner.
2. Owner accepts the Supabase Auth invitation at `/signup` and sets a password.
3. Super admin activates or rejects the company. Rejection requires a reason.
4. Activation changes organization state to `active` and enables the owner. The owner signs in through `/login`, then invites users and assigns organization roles.
5. Super admin can suspend/reactivate a company. Suspension immediately blocks its members from reading and writing company data.

Keep organization lifecycle (`pending`, `active`, `rejected`, `suspended`) separate from member lifecycle (`invited`, `active`, `revoked`). Users authenticate through Supabase Auth; super admins never set, view, or share user passwords. Audit activation, rejection, suspension, reactivation, and role changes.

## Required architecture

- Keep all application source and schema migrations in this repository.
- Vercel hosts the application and deploys from the connected Git repository.
- Supabase Auth handles user identity; Supabase Postgres stores app data.
- Use relational tables with an `organization_id` on every tenant-owned record.
- Enable and verify Row Level Security (RLS) on every tenant-owned table. A user must only access organizations where they have active membership and the appropriate role.
- Never put a service-role key or other privileged secret in browser code. Use it only in protected server-side code when required.
- Use versioned database migrations. Include a safe `.env.example` with placeholder values; never commit real secrets.

## Functional scope

Implement persistent data support for the current Smart Book modules:

- Organizations, memberships, roles, and business profiles.
- Organization signup requests and company lifecycle status.
- A separately provisioned platform-admin identity/role; public signup must never assign it.
- Income/expense categories and transactions.
- Credit sales and payment settlements, linked so income is not counted twice.
- Budgets, line-item approvals/rejections, retirements, and audit events.
- Stock items and stock movements.
- Dispatches, workers, commission rules, vendor remittances, and commission payments.
- Invoices and reports derived from authorized organization data.

Preserve the PRD's financial rules: credit does not enter cash until settled; procurement is COGS expense data; delivery product value is held for the vendor and is not company income; delivery income and commissions are recognized only when delivered; returned deliveries earn nothing.

## Security and correctness

- Do not trust an organization ID supplied by the browser as proof of access.
- Enforce membership, role permissions, and subscription access on the server/database boundary.
- Enforce that only active members of active organizations can access tenant data. Pending, rejected, and suspended organizations must be denied by RLS/API rules, including direct requests.
- Public signup is invitation-only. Only an authenticated, authorized platform admin can activate, reject, suspend, or reactivate a company.
- Keep super-admin and company-user portals on distinct routes with distinct authorization. A hidden link or frontend-only guard is not protection.
- Require auditable super-admin decisions and named admin identities with strong authentication; never use a shared or hard-coded admin password.
- Validate inputs and use database constraints/transactions for related financial changes.
- Keep an auditable record of approvals, rejections, retirements, remittances, and commission payments.
- Handle concurrent changes without silent last-write-wins replacement.
- Return clear errors and show success only after the database confirms the write.

## Delivery steps

1. Inspect the existing `index.html` and identify every local-storage read/write and current backend placeholder.
2. Propose and implement the relational schema and RLS policies as migrations.
3. Add Supabase client/auth integration and replace local-only persistence for production. Keep a deliberate local development mode only if it cannot be confused with production.
4. Implement the two login portals, invitation acceptance, email verification/reset, owner/member invitations, and pending-to-active workflow.
5. Implement secure initial super-admin provisioning and admin review/activate/reject/suspend/reactivate actions. Do not expose privileged provisioning credentials to the browser.
6. Configure Vercel environment variable names and document the values the project owner must provide. Do not invent credentials.
7. Verify signup cannot self-activate, public signup cannot obtain super-admin access, pending/suspended organizations are denied, and two tenants cannot access one another's data.
8. Document local setup, migrations, deployment, onboarding, and backup/recovery assumptions.

## Completion criteria

- Users authenticate and can access only their organization's data.
- Companies have separate signup/login from the private super-admin login.
- Pending companies cannot use the ledger; only super admin can activate them, with every decision auditable.
- Super-admin accounts cannot be created through public signup, and admin operations are authorized beyond the frontend.
- Data persists across refreshes and authorized devices.
- RLS denies cross-organization access even when requests are made directly.
- Core accounting and dispatch rules are preserved without duplicate income or incorrect liabilities.
- Migrations work on a clean Supabase project, and the app is ready for Vercel deployment once the owner supplies project credentials.
- No secrets are committed or shipped to the browser.

Refer to [PRD.md](./PRD.md) for the complete product requirements and open launch decisions.
