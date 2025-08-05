import { pgTable, varchar, timestamp, char } from 'drizzle-orm/pg-core';

export const player = pgTable('player', {
  playerId: varchar('player_id', { length: 64 }).primaryKey(),
  riotName: varchar('riot_name', { length: 128 }).notNull(),
  riotNameTag: varchar('riot_name_tag', { length: 128 }).notNull(),
  guildId: varchar('guild_id', { length: 64 }).notNull(),
  puuId: varchar('puuid', { length: 64 }).notNull(),
  mainPlayerId: varchar('main_player_id', { length: 64 }), 
  createDate: timestamp('create_date').defaultNow().notNull(),
  updateDate: timestamp('update_date')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  deleteYn: char('delete_yn', { length: 1 }).default('N').notNull(),
});

export const guild = pgTable('guild', {
  guildId: varchar('guild_id', { length: 128 }).primaryKey(),
  guildName: varchar('guild_name', { length: 128 }).notNull(),
  lanId: varchar('lan_id', { length: 32 }),
  createDate: timestamp('create_date').defaultNow().notNull(),
  updateDate: timestamp('update_date')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  deleteYn: char('delete_yn', { length: 1 }).default('N').notNull(),
});

export type Guild = typeof guild.$inferSelect;
export type InsertGuild = typeof guild.$inferInsert;

export type Player = typeof player.$inferSelect;