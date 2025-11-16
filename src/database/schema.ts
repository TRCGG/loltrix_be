import { pgTable, text, varchar, jsonb, char, timestamp, boolean, integer, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
  replayCode: varchar('replay_code', { length: 255 }).notNull().unique(),
  fileName: varchar('file_name', { length: 128 }).notNull(),
  fileUrl: varchar('file_url', { length: 255 }).notNull(),
  rawData: jsonb('raw_data').notNull(),
  hashData: varchar('hash_data', { length: 128 }).notNull(),
  gameType: char('game_type', { length: 1 }).notNull().default('1'),
  season: varchar('season', { length: 32 }).notNull(),
  createUser: varchar('create_user', { length: 255 }).notNull(),
  guildId: varchar('guild_id', { length: 128 }).notNull().references(() => guild.id),
  createDate: timestamp('create_date').notNull().defaultNow(),
  updateDate: timestamp('update_date').notNull().defaultNow(),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export type Guild = typeof guild.$inferSelect;
export type InsertGuild = typeof guild.$inferInsert;

export type Message = typeof message.$inferSelect;

export const errorLog = pgTable('error_log', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  errorCode: varchar('error_code', { length: 50 }).notNull().unique(),
  error: jsonb('error').notNull(),
  request: jsonb('request'),
  userAgent: varchar('user_agent', { length: 512 }),
  ipAddress: varchar('ip_address', { length: 45 }),
  userId: varchar('user_id', { length: 255 }),
  severity: varchar('severity', { length: 20 }).notNull().default('error'),
  status: integer('status').notNull().default(500),
  createDate: timestamp('create_date').notNull().defaultNow(),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export type Replay = typeof replay.$inferSelect;

export type ErrorLog = typeof errorLog.$inferSelect;
export type InsertErrorLog = typeof errorLog.$inferInsert;

export const riotAccount = pgTable('riot_account', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  puuid: varchar('puuid', { length: 128 }).notNull().unique(),
  playerCode: varchar('player_code', {length: 64 })
  .generatedAlwaysAs(sql`'PLR_' || lpad(id::text, 6, '0')`, )
  .notNull().unique(),
  riotName: varchar('riot_name', { length: 128 }).notNull(),
  riotNameTag: varchar('riot_name_tag', { length: 128 }).notNull(),
  isMain: boolean('is_main').notNull().default(true),
  createDate: timestamp('create_date').notNull().defaultNow(),
  updateDate: timestamp('update_date')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export type RiotAccount = typeof riotAccount.$inferSelect;
export type InsertRiotAccount = typeof riotAccount.$inferInsert;

/**
 * Discord 회원 기본 정보
 */
export const discordMember = pgTable('discord_member', {
  id: text('id').primaryKey(), // discord_id
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  createDate: timestamp('create_date', { withTimezone: true }).defaultNow(),
  updateDate: timestamp('update_date', { withTimezone: true }).defaultNow(),
  deleteYn: char('delete_yn', { length: 1 }).default('N'),
});

export type DiscordMember = typeof discordMember.$inferSelect;
export type InsertDiscordMember = typeof discordMember.$inferInsert;

/**
 * Discord OAuth 토큰 정보
 * discord_member 테이블의 id를 참조합니다.
 */
export const discordToken = pgTable('discord_token', {
  id: text('id')
    .primaryKey()
    .references(() => discordMember.id),
  accessToken: text('access_token').notNull(),
  acExpiresDate: timestamp('ac_expires_date', { withTimezone: true }).notNull(), 
  refreshToken: text('refresh_token').notNull(),
  reExpiresDate: timestamp('re_expires_date', { withTimezone: true }).notNull(), 
  scope: text('scope').notNull(), 
  tokenType: text('token_type').notNull(), 
  rotatedDate: timestamp('rotated_date', { withTimezone: true }), 
  revokedDate: timestamp('revoked_date', { withTimezone: true }), 
  createDate: timestamp('create_date', { withTimezone: true }).defaultNow(),
});

export type DiscordToken = typeof discordToken.$inferSelect;
export type InsertDiscordToken = typeof discordToken.$inferInsert;

/**
 * 인증 세션 정보
 * discord_member 테이블의 id를 참조합니다.
 */
export const authSession = pgTable('auth_session', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  discordMemberId: text('discord_member_id').notNull(),
  sessionUid: uuid('session_uid').defaultRandom().notNull(),
  userAgent: text('user_agent'),
  ipAddr: text('ip_addr'),
  deviceName: text('device_name'),
  isActive: boolean('is_active').default(true),
  createDate: timestamp('create_date', { withTimezone: true }).defaultNow(),
  updateDate: timestamp('update_date', { withTimezone: true }).defaultNow(),
});

export type AuthSession = typeof authSession.$inferSelect;
export type InsertAuthSession = typeof authSession.$inferInsert;