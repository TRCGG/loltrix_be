import { pgTable, uuid, varchar, text, timestamp } from 'drizzle-orm/pg-core';

export const guilds = pgTable('guilds', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Guild = typeof guilds.$inferSelect;
export type InsertGuild = typeof guilds.$inferInsert;