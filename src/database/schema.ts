import { pgTable, varchar, timestamp, char } from 'drizzle-orm/pg-core';

export const guild = pgTable('guild', {
  guildId: varchar('guild_id', { length: 128 }).primaryKey(),
  guildName: varchar('guild_name', { length: 128 }).notNull(),
  lanId: varchar('lan_id', { length: 32 }),
  createDate: timestamp('create_date').defaultNow().notNull(),
  updateDate: timestamp('update_date').defaultNow().notNull().$onUpdate(() => new Date()),
  deleteYn: char('delete_yn', { length: 1 }).default('N').notNull(),
});

export type Guild = typeof guild.$inferSelect;
export type InsertGuild = typeof guild.$inferInsert;