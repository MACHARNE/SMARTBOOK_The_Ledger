# Smart Book — Product Requirements Document

**Version:** 1.2
**Status:** Backend and deployment specification
**Owner:** Paul
**Product:** Smart Book

## 1. Overview

Smart Book is a multi-tenant accounting and operations ledger for small and medium businesses. It supports sales, expenses, credit tracking, procurement, stock, budgets, dispatches, commissions, invoices, and business reports.

The application source is maintained in Git and deployed to Vercel. Supabase provides the production database and authentication services. Vercel hosts the application and may host server-side API routes when privileged operations are needed. Each business organization must only be able to access its own records.

## 2. Goals

- Record business transactions and operations in one place.
- Produce trading account and profit-and-loss reports by day, week, month, and year.
- Support spending approval and an auditable decision history.
- Give owners remote access to current business information.
- Support multiple businesses from one deployed application with strict organization data isolation.
- Use Git as the source of truth and Vercel as the deployment platform.
- Use Supabase for authentication and persistent application data.

**Out of scope:** Full double-entry accounting, balance sheets, depreciation, and replacing a chartered accountant.

## 3. Login portals, signup, and user roles

Smart Book has two distinct entry points:

- **Super-admin portal:** `/super-admin/login` is the separate login route for platform super administrators. There is no public super-admin signup. The first named super-admin account is provisioned through a secure operator process. Super admins review company signup requests, activate or suspend companies, and manage organization-owner onboarding.
- **Company user portal:** `/login` is for normal organization users. `/signup` accepts invitations only. Company owners are invited and provisioned by a super admin; public visitors cannot create companies or memberships. New organizations remain pending until approved and grant no ledger access before activation.

Company activation never means the super admin sets, sees, or shares a user's password. Supabase Auth handles identity, email verification, invitations, and password reset. User identity verification and company approval are separate states: a verified user still has no company data access while the organization is pending, rejected, or suspended.

Both portals may use the same Vercel deployment and codebase, but must use distinct routes and authorization. A hidden link or frontend-only route check is not a security boundary. Super-admin actions must be authorized server-side or by database policies and recorded in the audit trail.

### 3.1 Signup and activation workflow

1. A super admin enters company/contact details in the admin portal and invites its owner by email.
2. The system creates a `pending` organization, a pending owner membership, and an approval request. No operational data access is granted.
3. The owner accepts the invitation at `/signup`, sets a password, and verifies their Supabase Auth identity.
4. A super admin reviews and activates or rejects the company. Rejection and suspension require a reason; decisions are audited.
5. Activation changes the organization to `active` and enables the owner. The owner signs in through `/login` and can invite users with allowed organization roles.
6. Suspension immediately prevents all organization members from reading or writing operational data. Reactivation restores access without changing records.

Organization statuses: `pending`, `active`, `rejected`, `suspended`. Membership statuses: `invited`, `active`, `revoked`. Signup, activation, rejection, suspension, reactivation, and membership changes are auditable.

- **Owner/approver:** reviews reports and approves or rejects budget lines.
- **Accountant/bookkeeper:** records transactions, prepares budgets, and records approved spend.
- **Front-line staff:** records assigned sales or deliveries.
- **Investor/member:** receives owner-generated read-only snapshots; no operational access by default.
- **Platform super admin:** reviews signup requests, activates/suspends organizations, and manages organization-owner onboarding.

Organization users must belong to an active organization. Authorization must be enforced by Supabase Row Level Security (RLS), not only by hiding screens or filtering data in the browser. Organization roles are owner, accountant, staff, and viewer. Super-admin authority is separate from organization membership and cannot be granted through public signup.

## 4. Deployment and system architecture

- **Source control:** application code and database migrations are committed to the project Git repository.
- **Hosting:** Vercel deploys the web application from the Git repository. Production and preview deployments use separate environment configuration where needed.
- **Backend language/runtime:** TypeScript on Node.js, deployed as Vercel server-side functions. Express is not required for the initial API surface.
- **Database and authentication:** Supabase Postgres and Supabase Auth.
- **Data access:** the frontend uses the Supabase client with the public project URL and anon/publishable key. RLS policies authorize every row operation.
- **Privileged operations:** service-role credentials must never be included in browser code. Any operation requiring them must run in a protected Node.js function/API route and validate the authenticated user and organization.
- **Configuration:** secrets and environment-specific values are configured in Vercel environment variables, not committed to Git. Local development uses an ignored local environment file and a documented example file containing placeholders only.
- **Schema management:** schema changes are versioned as Supabase SQL migrations in Git and applied deliberately to the relevant Supabase project.

Vercel is the application hosting and deployment platform. Supabase is the database and authentication provider. Deployment succeeds only when the required environment variables and database migrations are configured.

## 5. Core modules

### 5.1 Sales and revenue

Cash sales are recorded as income transactions. Credit sales are recorded as receivables and do not affect cash until payment is received. Records include date, customer, category, description, amount, payment method or due date, and recording user.

### 5.2 Expenses and procurement

Expenses have categories and may be classified as cost of goods sold (COGS). Procurement is the filtered view of COGS expenses. Procurement can optionally create a stock-in movement in the same logical operation.

### 5.3 Ledger hub

Provide Sales, Expense, Procurement, Cash, Credit, and Budget ledgers with suitable date filters. Cash ledger supports review and export. Destructive changes must be permission checked and auditable.

### 5.4 Credit management

Track outstanding and collected credit. Payment settlement records a real cash income entry and links it to the credit record so reports do not count it twice. The first release may require full settlement; partial settlement is a later enhancement unless the client confirms it as essential.

### 5.5 Stock book

Track stock items and dated in/out movements, with a calculated running quantity balance. Stock valuation is not included in the initial release.

### 5.6 Budget governance

Accountants submit budgets containing line items. Authorized approvers decide on each line; rejection requires a reason. Approved amounts can be retired as payments, with partial retirement allowed up to the approved amount. Any permitted overspend requires a reason. Submission, decisions, and retirements are retained in an audit trail.

### 5.7 Dispatch and commission

Dispatch records distinguish vendor product value from the business's delivery income. The app calculates vendor remittance due and commission for assigned workers. Delivery income and commission are recognized only when delivered; returned deliveries earn nothing. Vendor remittance and worker commission payments are separately recorded and auditable.

### 5.8 Invoicing

Generate an invoice from a sale using the organization's business profile. Support on-screen rendering, image sharing where supported by the device, and text/copy fallback. Sequential persistent invoice numbering is a future improvement unless required for launch.

### 5.9 Reports

- Trading Account: Sales − COGS = Gross Profit.
- Income Statement: Gross Profit + Other Income − Operating Expenses = Net Profit.
- Day, week, month, and year report filters are available at launch.
- Investor snapshot is an owner-generated read-only summary. Organization-wide Excel exports are server-side and reserved for super admins; no export control is shown to company users at launch.

### 5.10 Settings

Organizations can configure business name, contact and invoice details, income/expense categories, COGS flags, commission roles/rates, and workers. Organization configuration is isolated by tenant.

## 6. Data model

Use relational Postgres tables rather than storing all organization data as one JSON blob. Every tenant-owned table must include an `organization_id` foreign key and have RLS policies restricting access to organizations of which the authenticated user is a member.

Suggested initial tables:

- `organizations`
- `organization_signup_requests` (request details, status, reviewer, reason, timestamps)
- `organization_members` (user, organization, role, membership status)
- `platform_admins` (Supabase Auth user ID and super-admin role, provisioned only through a secure operator process)
- `business_profiles`
- `categories`
- `transactions`
- `credit_sales` and, if partial payments are enabled, `credit_payments`
- `budgets`, `budget_items`, and `audit_events`
- `stock_items`, `stock_movements`
- `commission_roles`, `workers`, `dispatches`, `vendor_remittances`, `commission_payments`
- `invoices` or invoice-number fields on sales, depending on implementation

Use database constraints and transactions for financial invariants, such as valid amounts, organization ownership, and settlement links. Store timestamps in a consistent timezone-aware format and render in the user's locale. Avoid duplicating computed totals where they can be safely derived from source records.

## 7. Security and tenant isolation

- Supabase Auth identifies users; organization membership and role determine access.
- Enable RLS on every table containing tenant data before exposing it to the client.
- Policies must validate organization membership for reads and writes; client-supplied organization IDs alone are never authorization.
- Keep service-role keys and other secrets server-side only.
- Validate all input and enforce authorization for sensitive actions, including approvals, retirements, remittances, and commission payments.
- Record sensitive changes in an append-oriented audit table with actor, timestamp, action, and relevant before/after or decision details.
- Subscription status should be checked by a trusted server-side operation or database policy where it controls access; it must not rely solely on a client-side flag.
- Public signup is invitation-only; company invitations create pending access and never grant platform-admin authority.
- Super-admin actions require explicit server-side authorization, must be isolated from organization-user sessions, and must create audit events.
- RLS must deny organization data access unless membership is active and organization status is active.
- Do not use a shared super-admin password or hard-coded credential. Use a named Supabase Auth identity with strong authentication and a secure recovery process.

## 8. Non-functional requirements and known limits

- Concurrent edits must not silently overwrite newer data. Use row-level updates, constraints, and transactions; show a useful conflict/error state when an operation cannot be completed.
- Backups, database retention, and recovery expectations must be agreed before production launch.
- Test RLS using at least two organizations and multiple user roles before real client data is entered.
- Provide clear loading, save success, and failure states. Do not imply a save succeeded until the database confirms it.
- The app should remain usable on common mobile browsers and support poor connectivity with clear retry behavior. Offline-first synchronization is not part of the initial release unless separately scoped.

## 9. Launch acceptance criteria

1. Super admin invites/provisions a company owner; pending/rejected companies cannot access operational data.
2. Company users sign in through `/login`; super admins sign in through `/super-admin/login` and have no public signup path.
3. Only an authorized super admin can activate, reject, suspend, or reactivate a company; decisions are audited.
4. An active organization user can access only organizations they belong to, with permissions limited by their role.
5. Two test organizations cannot read or modify one another's records, including through direct API requests.
6. Core ledger records persist in Supabase and remain available after refresh and on another authorized device.
7. Credit settlement, budget decisions, dispatch calculations, remittances, and commission payments produce consistent records without double counting.
8. Vercel preview and production deployments use the correct Supabase configuration, with no privileged key in client assets.
9. Database migrations are committed and can be applied to a clean project.
10. Owner invitation, email verification, password reset, and organization suspension flows work as documented.

## 10. Roadmap

- Multi-user role refinements and staff-specific permissions.
- Day-close cash reconciliation and variance history.
- Month-end checklist.
- Partial credit payments if not included in initial scope.
- Persistent invoice numbering.
- Stock valuation integration.
- Subscription billing and automated access lifecycle, if required by the business model.
- Super-admin multi-factor authentication and recovery hardening beyond email/password and password reset.

## 11. Open decisions

- Which Supabase project and Vercel account/team will own production?
- Which named person(s) will hold super-admin authority, and what MFA/recovery policy is required?
- Company owner onboarding is invitation-only; which company details or evidence must be collected before approval?
- What company details or evidence must be collected before activation?
- Should activation notify the owner by email, and which sending service will be used?
- Which roles are required for the first client at launch?
- Are partial credit payments required at launch?
- What backup, retention, and recovery targets does the client expect?
- Is a paid plan / subscription gate needed for the first deployment, or is onboarding managed manually initially?
