import { BadRequestException, Injectable } from '@nestjs/common';
import { and, desc, gte, inArray, lt, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { campaigns, campaignDeliveries, contacts } from '../database/schema.js';

const SENT_STATUSES = ['Sent', 'Sent with failures'];
const CHANNELS = ['Email', 'SMS', 'WhatsApp'] as const;

@Injectable()
export class AnalyticsService {
  constructor(private readonly database: DatabaseService) {}

  async getReport(rawPeriod?: string) {
    const days = rawPeriod === undefined ? 30 : Number(rawPeriod);
    if (![7, 30, 90].includes(days)) throw new BadRequestException('period must be 7, 30, or 90 days');

    const now = new Date();
    const startAt = new Date(now);
    startAt.setUTCDate(startAt.getUTCDate() - days);
    const previousStartAt = new Date(startAt);
    previousStartAt.setUTCDate(previousStartAt.getUTCDate() - days);

    const db = this.database.db;
    const [contactTotals, newContacts, previousContacts, campaignRows, recentRows, statusRows, emailOptIns, smsOptIns, whatsappOptIns] = await Promise.all([
      db.select({ total: sql<number>`count(*)::int` }).from(contacts),
      db.select({ total: sql<number>`count(*)::int` }).from(contacts).where(and(gte(contacts.createdAt, startAt), lt(contacts.createdAt, now))),
      db.select({ total: sql<number>`count(*)::int` }).from(contacts).where(and(gte(contacts.createdAt, previousStartAt), lt(contacts.createdAt, startAt))),
      db.select().from(campaigns).where(and(inArray(campaigns.status, SENT_STATUSES), gte(campaigns.sentAt, previousStartAt), lt(campaigns.sentAt, now))),
      db.select().from(campaigns).orderBy(desc(campaigns.createdAt)).limit(10),
      db.select({ status: campaigns.status, total: sql<number>`count(*)::int` }).from(campaigns).groupBy(campaigns.status),
      db.select({ total: sql<number>`count(*)::int` }).from(contacts).where(sql`${contacts.emailConsent} = 'Subscribed'`),
      db.select({ total: sql<number>`count(*)::int` }).from(contacts).where(sql`${contacts.smsConsent} = 'Subscribed'`),
      db.select({ total: sql<number>`count(*)::int` }).from(contacts).where(sql`${contacts.whatsappConsent} = 'Subscribed'`),
    ]);

    const sent = campaignRows.filter((row) => SENT_STATUSES.includes(row.status) && row.sentAt && row.sentAt >= startAt && row.sentAt < now);
    const previousSent = campaignRows.filter((row) => SENT_STATUSES.includes(row.status) && row.sentAt && row.sentAt >= previousStartAt && row.sentAt < startAt);
    const campaignIds = [...new Set([...sent, ...previousSent, ...recentRows].map((row) => row.id))];
    const deliveryRows = campaignIds.length ? await db.select({ campaignId: campaignDeliveries.campaignId, status: campaignDeliveries.status, total: sql<number>`count(*)::int` })
      .from(campaignDeliveries).where(inArray(campaignDeliveries.campaignId, campaignIds))
      .groupBy(campaignDeliveries.campaignId, campaignDeliveries.status) : [];
    const deliveryByCampaign = new Map<string, { delivered: number; failed: number }>();
    for (const row of deliveryRows) {
      const counts = deliveryByCampaign.get(row.campaignId) ?? { delivered: 0, failed: 0 };
      if (['delivered', 'read'].includes(row.status.toLowerCase())) counts.delivered += row.total;
      if (['failed', 'undelivered', 'process_failed'].includes(row.status.toLowerCase()))
        counts.failed += row.total;
      deliveryByCampaign.set(row.campaignId, counts);
    }

    const firstTrendDay = new Date(now);
    firstTrendDay.setUTCHours(0, 0, 0, 0);
    firstTrendDay.setUTCDate(firstTrendDay.getUTCDate() - days + 1);
    const trends = Array.from({ length: days + 1 }, (_, index) => {
      const day = new Date(firstTrendDay);
      day.setUTCDate(day.getUTCDate() + index);
      const date = day.toISOString().slice(0, 10);
      return { date, contactsAdded: 0, campaignsSent: 0, recipients: 0, delivered: 0, failed: 0 };
    });
    const trendMap = new Map(trends.map((row) => [row.date, row]));
    const contactDay = sql<string>`to_char(${contacts.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const contactDates = await db.select({ date: contactDay, total: sql<number>`count(*)::int` })
      .from(contacts).where(and(gte(contacts.createdAt, startAt), lt(contacts.createdAt, now))).groupBy(contactDay);
    for (const row of contactDates) { const point = trendMap.get(row.date); if (point) point.contactsAdded = row.total; }
    for (const row of sent) {
      const date = row.sentAt!.toISOString().slice(0, 10);
      const point = trendMap.get(date);
      if (!point) continue;
      point.campaignsSent += 1;
      point.recipients += row.recipientCount;
      // A provider acceptance is not a confirmed delivery. If an older or
      // incomplete record has no delivery rows, report zero confirmed rather
      // than falling back to the provider-accepted count.
      point.delivered += row.channel === 'WhatsApp' ? (deliveryByCampaign.get(row.id)?.delivered ?? 0) : 0;
      point.failed += row.channel === 'WhatsApp' ? (deliveryByCampaign.get(row.id)?.failed ?? row.failedCount) : row.failedCount;
    }

    const channelStats = CHANNELS.map((channel) => {
      const rows = sent.filter((row) => row.channel.toLowerCase() === channel.toLowerCase());
      const tracked = channel === 'WhatsApp';
      const accepted = channel === 'SMS' ? rows.reduce((sum, row) => sum + row.deliveredCount, 0) : 0;
      const confirmed = rows.reduce((sum, row) => sum + (deliveryByCampaign.get(row.id)?.delivered ?? 0), 0);
      const failed = rows.reduce((sum, row) => sum + (deliveryByCampaign.get(row.id)?.failed ?? row.failedCount), 0);
      const recipients = rows.reduce((sum, row) => sum + row.recipientCount, 0);
      return { channel, campaignsSent: rows.length, recipients, providerAccepted: accepted, delivered: tracked ? confirmed : null, failed: tracked ? failed : null, deliveryRate: tracked && recipients > 0 ? Math.round((confirmed / recipients) * 1000) / 10 : null, deliveryTrackingAvailable: tracked };
    });
    const recentCampaigns = recentRows.map((row) => ({
      id: row.id, name: row.name, channel: row.channel, status: row.status, sentAt: row.sentAt,
      recipients: row.recipientCount, providerAccepted: row.deliveredCount, failed: row.failedCount,
      trackedDelivery: row.channel === 'WhatsApp' ? deliveryByCampaign.get(row.id)?.delivered ?? 0 : null,
    }));

    return {
      generatedAt: now.toISOString(),
      range: { days, startAt: startAt.toISOString(), endAt: now.toISOString(), previousStartAt: previousStartAt.toISOString(), previousEndAt: startAt.toISOString() },
      summary: {
        contactsTotal: contactTotals[0]?.total ?? 0,
        contactsAdded: newContacts[0]?.total ?? 0,
        contactsAddedPrevious: previousContacts[0]?.total ?? 0,
        campaignsSent: sent.length,
        campaignsSentPrevious: previousSent.length,
        recipients: sent.reduce((sum, row) => sum + row.recipientCount, 0),
        providerAccepted: sent.filter((row) => row.channel === 'SMS').reduce((sum, row) => sum + row.deliveredCount, 0),
        whatsappDelivered: sent.filter((row) => row.channel === 'WhatsApp').reduce((sum, row) => sum + (deliveryByCampaign.get(row.id)?.delivered ?? 0), 0),
        failed: sent.reduce((sum, row) => sum + row.failedCount, 0),
      },
      consent: {
        email: emailOptIns[0]?.total ?? 0,
        sms: smsOptIns[0]?.total ?? 0,
        whatsapp: whatsappOptIns[0]?.total ?? 0,
      },
      channels: channelStats,
      trends,
      campaignStatuses: statusRows.map(({ status, total }) => ({ status, count: total })),
      recentCampaigns,
      engagement: { opens: null, clicks: null, unsubscribes: null, available: false, note: 'Engagement metrics are not synchronized from campaign providers.' },
    };
  }
}
