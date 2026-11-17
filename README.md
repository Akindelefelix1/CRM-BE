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

To configure Zoho Campaigns, create a **Self Client** in the [Zoho API Console](https://api-console.zoho.com/), generate an authorization grant for `ZohoCampaigns.campaign.ALL,ZohoCampaigns.contact.CREATE,ZohoCampaigns.contact.UPDATE`, then exchange that grant for a refresh token using Zoho's OAuth flow. The separate contact CREATE and UPDATE scopes avoid the aggregate `contact.CREATE-UPDATE` scope rejected by some Self Client consoles, and provide the exact permissions used by the API. Put the client ID, client secret, and refresh token in the backend host's secret environment variables; never put them in the frontend or commit them. Set `ZOHO_CAMPAIGNS_FROM_EMAIL` to a sender verified in Zoho Campaigns. Match `ZOHO_CAMPAIGNS_ACCOUNTS_URL` and `ZOHO_CAMPAIGNS_API_URL` to the data center shown in your Zoho Campaigns URL (for example, `.eu` accounts and Campaigns URLs for an EU account). The Settings → Integrations page includes a read-only connection check; it verifies OAuth and the Campaigns read scope without exposing the access token. See Zoho's [OAuth scope guide](https://www.zoho.com/campaigns/help/developers/access-token.html), [Self Client guide](https://www.zoho.com/developer/oauth/self-client/overview.html), and [data center list](https://www.zoho.com/campaigns/help/developers/data-centers.html).

## Bulk SMS

SMS campaigns are saved in Neon and sent through Termii's bulk messaging endpoint in batches of up to 100 numbers. Configure `TERMII_API_KEY`, the account-specific `TERMII_BASE_URL` from the Termii dashboard, `TERMII_SENDER_ID`, `TERMII_COUNTRY_CODE` (defaults to `234`), and `TERMII_CHANNEL` (defaults to the promotional `generic` route) in the API environment. Register and activate the sender ID in Termii first. The CRM sends only to contacts with SMS consent set to `Subscribed`, resolves audience exclusions, normalizes Nigerian local numbers to international format, removes duplicate phone numbers, and records provider-accepted and failed counts per contact so retries do not repeat accepted sends. Delivery receipts are not configured, so accepted counts are not handset delivery confirmation. Scheduled SMS is not enabled: Termii's campaign scheduler requires a Termii phonebook, while this CRM resolves contacts from its own audience database.

## WhatsApp campaigns

WhatsApp messages are sent individually through Zoho CPaaS using an approved template. Configure `ZOHO_WHATSAPP_API_KEY` with the WhatsApp API key for the sending Agent; `ZOHO_WHATSAPP_API_URL` defaults to `https://cpaas.zoho.com/v1.1/whatsapp`. Each draft stores the sender number, template key or alias, and a JSON map of template merge values. Values may include `{{first_name}}`, `{{last_name}}`, `{{full_name}}`, `{{email}}`, `{{phone}}`, or `{{organization}}`. The CRM requires separate WhatsApp consent, only includes opted-in contacts, and stores CPaaS message IDs. Delivery refresh queries CPaaS logs and updates delivered, read, failed, and pending counts. CPaaS supports Utility and Authentication templates; its Marketing templates are not supported. Schedule support is disabled because campaign contacts are not synchronized to CPaaS phonebooks.

## API

- `GET/POST /api/contacts`, `GET/PATCH/DELETE /api/contacts/:id`
- `GET/POST /api/audiences`, `GET/PATCH/DELETE /api/audiences/:id`
- `POST /api/audiences/:id/members` with `{ "contactIds": ["<uuid>"] }`
- `DELETE /api/audiences/:id/members/:contactId`
- `POST /api/files` multipart form field `file` (20 MB maximum)
- `GET /api/files`, `GET /api/files/:id/url`, `DELETE /api/files/:id`
- `GET /api/health`
- `GET/POST /api/campaigns`, `PATCH /api/campaigns/:id`, and campaign approval, send, schedule, pause, cancel, and public content endpoints
- `GET /api/campaigns/sms/provider-status` returns non-secret Termii configuration status
- `GET /api/campaigns/whatsapp/provider-status` returns non-secret Zoho CPaaS configuration status
- `POST /api/campaigns/:id/whatsapp-delivery` refreshes message states from Zoho CPaaS
- `GET/POST /api/templates`, `PATCH/DELETE /api/templates/:id`, and `POST /api/templates/:id/use`

Files are stored privately under generated object keys. The API returns a five-minute signed download URL; original filenames are metadata only. File metadata lives in Postgres and is cleaned up if the object upload fails.

## Database changes

Edit `src/database/schema.ts`, generate a migration with `npm run db:generate`, review the generated SQL, then apply it with `npm run db:migrate`. Do not use `drizzle-kit push` against production.
