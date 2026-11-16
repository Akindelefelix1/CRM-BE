ALTER TABLE "campaigns" ADD COLUMN "delivered_contact_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "failed_contact_ids" text[] DEFAULT '{}' NOT NULL;