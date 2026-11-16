import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const consentStatus = pgEnum('consent_status', [
  'Subscribed',
  'Unsubscribed',
  'Pending',
]);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull().default(''),
    email: text('email').notNull().unique(),
    alternateEmails: text('alternate_emails').array().notNull().default([]),
    phone: text('phone'),
    organization: text('organization'),
    category: text('category').notNull().default('Uncategorized'),
    location: text('location'),
    interests: text('interests').array().notNull().default([]),
    tags: text('tags').array().notNull().default([]),
    emailConsent: consentStatus('email_consent').notNull().default('Pending'),
    smsConsent: consentStatus('sms_consent').notNull().default('Pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('contacts_name_idx').on(table.lastName, table.firstName)],
);

export const contactCategories = pgTable('contact_categories', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const audiences = pgTable('audiences', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  type: text('type').notNull().default('static'),
  rules: text('rules').notNull().default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const audienceMembers = pgTable(
  'audience_members',
  {
    audienceId: uuid('audience_id').notNull().references(() => audiences.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.audienceId, table.contactId] })],
);

export const storedFiles = pgTable('stored_files', {
  id: uuid('id').defaultRandom().primaryKey(),
  objectKey: text('object_key').notNull().unique(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  isPrivate: boolean('is_private').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
