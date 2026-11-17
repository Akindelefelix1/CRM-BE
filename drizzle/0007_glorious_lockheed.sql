CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"channel" text DEFAULT 'Email' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"email_blocks" text DEFAULT '[]' NOT NULL,
	"attachments" text[] DEFAULT '{}' NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"whatsapp_template" text,
	"whatsapp_sender" text,
	"whatsapp_merge_info" text DEFAULT '{}' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE INDEX "templates_channel_idx" ON "templates" USING btree ("channel");
--> statement-breakpoint
INSERT INTO "templates" ("name", "channel", "subject", "body", "email_blocks", "objective", "is_default") VALUES
	('Monthly newsletter', 'Email', 'Your monthly update from Cephas', E'Hello {{first_name}},\n\nHere is this month’s news, opportunities, and stories from the Cephas community.\n\nExplore the latest updates and share what you have been working on.', '[{"id":"newsletter-intro","type":"text","content":"Hello {{first_name}},\n\nHere is this month’s news, opportunities, and stories from the Cephas community."},{"id":"newsletter-updates","type":"text","content":"Explore the latest updates and share what you have been working on."}]', 'Keep your community up to date with monthly news and opportunities.', true),
	('Event invitation', 'Email', 'You’re invited, {{first_name}}', E'Hi {{first_name}},\n\nWe would love you to join us for an upcoming Cephas event.\n\nDate: {{event_date}}\nLocation: {{event_location}}\n\nSave your place today. We look forward to seeing you.', '[{"id":"event-invite","type":"text","content":"Hi {{first_name}},\n\nWe would love you to join us for an upcoming Cephas event."},{"id":"event-details","type":"text","content":"Date: {{event_date}}\nLocation: {{event_location}}\n\nSave your place today. We look forward to seeing you."}]', 'Invite your community to an event.', true),
	('Program welcome message', 'WhatsApp', '', E'Hi {{first_name}}, welcome to {{program_name}}! We’re glad you’re joining us. Your program contact is {{contact_name}}. Reply here if you have any questions.', '[]', 'Welcome a new participant to a program.', true)
ON CONFLICT ("name") DO NOTHING;
