CREATE TABLE "contact_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_categories_name_unique" UNIQUE("name")
);
--> statement-breakpoint
INSERT INTO "contact_categories" ("name")
SELECT DISTINCT "category" FROM "contacts" WHERE "category" IS NOT NULL AND btrim("category") <> ''
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
INSERT INTO "contact_categories" ("name") VALUES ('Uncategorized') ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "alternate_emails" text[] DEFAULT '{}' NOT NULL;
