# Smart Book — The Ledger

This repository keeps the client's existing interface intact while preparing separate areas for the frontend and backend work described in [PRD.md](./PRD.md).

## Project layout

```text
SMARTBOOK_The_Ledger/
├── fb091d/                 # Client-facing frontend; original index.html is preserved here
│   └── index.html
├── bk095d/                 # Backend implementation area
│   ├── api/                # Server-side API handlers, when implemented
│   └── migrations/         # Versioned Supabase SQL migrations
├── docs/                   # Supporting project documentation
├── PRD.md                  # Product and architecture requirements
└── pre.md                  # Backend implementation brief
```

## Interface preservation

The current client interface was moved from the repository root into `fb091d/index.html` without editing its contents. Preserve its screens, styling, wording, and workflows. Add only the login, signup, super-admin approval, and other backend-connected behavior required by the PRD; do not redesign the client UI.

## Planned services

- Git is the source of truth.
- Vercel will deploy the app.
- Supabase will provide authentication and Postgres storage with Row Level Security.
- Backend functions use TypeScript on Node.js; Express is not required for the initial serverless API.

No credentials or deployment configuration are included yet. Follow `pre.md` for the implementation scope and security requirements.

## Environment values

Copy `.env.example` to a local ignored `.env` for local functions and configure the same names in Vercel Preview and Production. `SUPABASE_URL` and `SUPABASE_ANON_KEY` are public project values; `SUPABASE_SERVICE_ROLE_KEY` is a private server secret. `AUTH_EMAIL_REDIRECT_URL` must be included in Supabase Auth's allowed redirect URLs. The initial-admin variables are temporary and should be removed after provisioning. Never commit actual credentials.

Schema application steps, including the SQL Editor fallback, are in [docs/apply-supabase-migrations.md](./docs/apply-supabase-migrations.md).
