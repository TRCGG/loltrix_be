import { pgTable, text, varchar, jsonb, char, timestamp, boolean, integer } from 'drizzle-orm/pg-core';

export const guild = pgTable('guild', {
  id: varchar('id', { length: 128 }).primaryKey(),
  name: varchar('name', { length: 128 }).notNull(),
  languageCode: varchar('language_code', { length: 10 }).notNull().default('ko'),
  createDate: timestamp('create_date').notNull().defaultNow(),
  updateDate: timestamp('update_date')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export const message = pgTable('message', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  key: varchar('key', { length: 255 }).notNull(),
  value: text('value').notNull(),
  languageCode: varchar('language_code', { length: 10 }).notNull(),
  createDate: timestamp('create_date').notNull().defaultNow(),
  updateDate: timestamp('update_date')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export const replay = pgTable('replay', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  fileUrl: varchar('file_url', { length: 255 }).notNull(),
  rawData: jsonb('raw_data').notNull(),
  hashData: varchar('hash_data', { length: 128 }).notNull(),
  gameType: char('game_type', { length: 1 }).notNull().default('1'),
  createUser: varchar('create_user', { length: 255 }).notNull(),
  guildId: varchar('guild_id', { length: 128 }).notNull().references(() => guild.id),
  createDate: timestamp('create_date').notNull().defaultNow(),
  updateDate: timestamp('update_date').notNull().defaultNow(),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export type Guild = typeof guild.$inferSelect;
export type InsertGuild = typeof guild.$inferInsert;

export type Message = typeof message.$inferSelect;

export type Replay = typeof replay.$inferSelect;
export type InsertReplay = typeof replay.$inferInsert;