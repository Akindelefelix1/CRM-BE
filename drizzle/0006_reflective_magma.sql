CREATE TABLE "campaign_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"provider_message_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "whatsapp_template" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "whatsapp_sender" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "whatsapp_merge_info" text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "whatsapp_consent" "consent_status" DEFAULT 'Pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_deliveries" ADD CONSTRAINT "campaign_deliveries_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_deliveries" ADD CONSTRAINT "campaign_deliveries_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_deliveries_campaign_idx" ON "campaign_deliveries" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaign_deliveries_contact_idx" ON "campaign_deliveries" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_deliveries_campaign_contact_unique" ON "campaign_deliveries" USING btree ("campaign_id","contact_id");