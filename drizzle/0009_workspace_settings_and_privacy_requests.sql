CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"request_type" text NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'Received' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"organization_name" text DEFAULT 'Cephas People' NOT NULL,
	"timezone" text DEFAULT 'Africa/Lagos' NOT NULL,
	"sender_name" text DEFAULT 'Cephas People' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "privacy_requests_owner_created_idx" ON "privacy_requests" USING btree ("owner_id","created_at");