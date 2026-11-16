CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"channel" text DEFAULT 'Email' NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"subject" text NOT NULL,
	"blocks" text DEFAULT '[]' NOT NULL,
	"included_audiences" text[] DEFAULT '{}' NOT NULL,
	"excluded_audiences" text[] DEFAULT '{}' NOT NULL,
	"excluded_contacts" text[] DEFAULT '{}' NOT NULL,
	"attachment_names" text[] DEFAULT '{}' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE INDEX "campaigns_status_schedule_idx" ON "campaigns" USING btree ("status","scheduled_at");