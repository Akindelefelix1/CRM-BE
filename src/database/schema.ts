import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
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
    whatsappConsent: consentStatus('whatsapp_consent').notNull().default('Pending'),
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

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull().unique(),
    channel: text('channel').notNull().default('Email'),
    status: text('status').notNull().default('Draft'),
    objective: text('objective').notNull().default(''),
    subject: text('subject').notNull(),
    blocks: text('blocks').notNull().default('[]'),
    includedAudiences: text('included_audiences').array().notNull().default([]),
    excludedAudiences: text('excluded_audiences').array().notNull().default([]),
    excludedContacts: text('excluded_contacts').array().notNull().default([]),
    attachmentNames: text('attachment_names').array().notNull().default([]),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    recipientCount: integer('recipient_count').notNull().default(0),
    deliveredCount: integer('delivered_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    deliveredContactIds: text('delivered_contact_ids').array().notNull().default([]),
    failedContactIds: text('failed_contact_ids').array().notNull().default([]),
    zohoListKey: text('zoho_list_key'),
    zohoCampaignKey: text('zoho_campaign_key'),
    whatsappTemplate: text('whatsapp_template'),
    whatsappSender: text('whatsapp_sender'),
    whatsappMergeInfo: text('whatsapp_merge_info').notNull().default('{}'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('campaigns_status_schedule_idx').on(table.status, table.scheduledAt)],
);

export const templates = pgTable(
  'templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull().unique(),
    channel: text('channel').notNull().default('Email'),
    subject: text('subject').notNull().default(''),
    body: text('body').notNull().default(''),
    emailBlocks: text('email_blocks').notNull().default('[]'),
    attachments: text('attachments').array().notNull().default([]),
    objective: text('objective').notNull().default(''),
    whatsappTemplate: text('whatsapp_template'),
    whatsappSender: text('whatsapp_sender'),
    whatsappMergeInfo: text('whatsapp_merge_info').notNull().default('{}'),
    isDefault: boolean('is_default').notNull().default(false),
    useCount: integer('use_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('templates_channel_idx').on(table.channel)],
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

export const campaignDeliveries = pgTable(
  'campaign_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    providerMessageId: text('provider_message_id'),
    status: text('status').notNull().default('queued'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('campaign_deliveries_campaign_idx').on(table.campaignId),
    index('campaign_deliveries_contact_idx').on(table.contactId),
    uniqueIndex('campaign_deliveries_campaign_contact_unique').on(table.campaignId, table.contactId),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: text('actor_id').notNull(),
    actorName: text('actor_name').notNull(),
    actorEmail: text('actor_email'),
    action: text('action').notNull(),
    details: text('details').notNull().default(''),
    eventType: text('event_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_events_actor_created_idx').on(table.actorId, table.createdAt),
    index('audit_events_actor_type_idx').on(table.actorId, table.eventType),
  ],
);
