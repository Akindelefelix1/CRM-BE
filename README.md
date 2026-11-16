# Cephas CRM API

NestJS REST API for CRM contacts, audience groups, and private file uploads. PostgreSQL is provided by Neon; uploaded files use Neon Object Storage.

## Requirements

- Node.js 20+
- A Neon project with Postgres and Object Storage enabled

## Local setup

```sh
npm install
cp .env.example .env
neon env pull
npm run db:generate
npm run db:migrate
npm run start:dev
```

`neon env pull` fills the Neon-managed database, Auth, and Object Storage values into `.env` while preserving app settings. The API loads `.env` first and `.env.local` only as a fallback. `neon.ts` declares a private `uploads` bucket; run `neon deploy` after linking to provision it. Keep `.env` private; `.env.example` contains placeholders only.

The API listens on port 3000 by default, uses the `/api` prefix, and allows the Vite origin from `CORS_ORIGIN`.

## Email campaigns

Campaign drafts, audiences, consent checks, and schedules are stored in Neon. Marketing sends use Zoho Campaigns; individual contact emails and one-address test emails continue to use the configured ZeptoMail endpoint. Set the `ZOHO_CAMPAIGNS_*` variables in `.env` or the Render service environment. The Zoho OAuth refresh token must include campaign create/update/delete and contact create/update scopes. Set the verified Campaigns sender address, and set `ZOHO_CAMPAIGNS_TOPIC_ID` if the account requires topic management. In Render, `RENDER_EXTERNAL_URL` is used as the public campaign-content URL; locally, set `API_PUBLIC_URL` to a publicly reachable API URL. Campaigns are created and scheduled in Zoho so scheduled delivery does not depend on the Render process staying awake. Pausing or cancelling a scheduled campaign deletes its Zoho Campaigns copy; resuming creates and schedules it again.

## API

- `GET/POST /api/contacts`, `GET/PATCH/DELETE /api/contacts/:id`
- `GET/POST /api/audiences`, `GET/PATCH/DELETE /api/audiences/:id`
- `POST /api/audiences/:id/members` with `{ "contactIds": ["<uuid>"] }`
- `DELETE /api/audiences/:id/members/:contactId`
- `POST /api/files` multipart form field `file` (20 MB maximum)
- `GET /api/files`, `GET /api/files/:id/url`, `DELETE /api/files/:id`
- `GET /api/health`
- `GET/POST /api/campaigns`, `PATCH /api/campaigns/:id`, and campaign approval, send, schedule, pause, cancel, and public content endpoints

Files are stored privately under generated object keys. The API returns a five-minute signed download URL; original filenames are metadata only. File metadata lives in Postgres and is cleaned up if the object upload fails.

## Database changes

Edit `src/database/schema.ts`, generate a migration with `npm run db:generate`, review the generated SQL, then apply it with `npm run db:migrate`. Do not use `drizzle-kit push` against production.
