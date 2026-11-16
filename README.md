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

## API

- `GET/POST /api/contacts`, `GET/PATCH/DELETE /api/contacts/:id`
- `GET/POST /api/audiences`, `GET/PATCH/DELETE /api/audiences/:id`
- `POST /api/audiences/:id/members` with `{ "contactIds": ["<uuid>"] }`
- `DELETE /api/audiences/:id/members/:contactId`
- `POST /api/files` multipart form field `file` (20 MB maximum)
- `GET /api/files`, `GET /api/files/:id/url`, `DELETE /api/files/:id`
- `GET /api/health`

Files are stored privately under generated object keys. The API returns a five-minute signed download URL; original filenames are metadata only. File metadata lives in Postgres and is cleaned up if the object upload fails.

## Database changes

Edit `src/database/schema.ts`, generate a migration with `npm run db:generate`, review the generated SQL, then apply it with `npm run db:migrate`. Do not use `drizzle-kit push` against production.
