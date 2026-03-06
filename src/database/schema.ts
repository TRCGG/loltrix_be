import {
  pgTable,
  text,
  varchar,
  jsonb,
  char,
  timestamp,
  boolean,
  integer,
  uuid,
  unique,
} from 'drizzle-orm/pg-core';
import { sql, relations } from 'drizzle-orm';

export const guild = pgTable('guild', {
  id: varchar('id', { length: 128 }).primaryKey(),
  name: varchar('name', { length: 128 }).notNull(),
  languageCode: varchar('language_code', { length: 10 }).notNull().default('ko'),
  allowAllUploads: boolean('allow_all_uploads').notNull().default(true),
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
  guildId: varchar('guild_id', { length: 128 })
    .notNull()
    .references(() => guild.id),
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
  playerCode: varchar('player_code', { length: 64 })
    .generatedAlwaysAs(sql`'PLR_' || lpad(id::text, 6, '0')`)
    .notNull()
    .unique(),
  riotName: varchar('riot_name', { length: 128 }).notNull(),
  riotNameTag: varchar('riot_name_tag', { length: 128 }).notNull(),
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
  isDeleted: boolean('is_deleted').notNull().default(false),
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
export const customMatch = pgTable('custom_match', {
  id: varchar('id', { length: 255 }).primaryKey(),
  gameType: char('game_type', { length: 1 }).notNull().default('1'),
  guildId: varchar('guild_id', { length: 128 }).notNull(),
  season: varchar('season', { length: 32 }).notNull(),
  createDate: timestamp('create_date').notNull().defaultNow(),
  updateDate: timestamp('update_date')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export type CustomMatch = typeof customMatch.$inferSelect;
export type InsertCustomMatch = typeof customMatch.$inferInsert;

export const champion = pgTable('champion', {
  id: varchar('id', { length: 16 }).primaryKey(),
  champName: varchar('champ_name', { length: 128 }).notNull(),
  champNameEng: varchar('champ_name_eng', { length: 128 }).notNull(),
  createDate: timestamp('create_date', { withTimezone: true }).notNull().defaultNow(),
  updateDate: timestamp('update_date', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export const matchParticipant = pgTable('match_participant', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  customMatchId: varchar('custom_match_id', { length: 255 })
    .notNull()
    .references(() => customMatch.id),
  playerCode: varchar('player_code', { length: 64 })
    .notNull()
    .references(() => riotAccount.playerCode),
  championId: varchar('champion_id', { length: 16 })
    .notNull()
    .references(() => champion.id),
  gameTeam: varchar('game_team', { length: 8 }).notNull(),
  gameResult: varchar('game_result', { length: 8 }).notNull(),
  position: varchar('position', { length: 16 }).notNull(),
  kill: integer('kill').notNull(),
  death: integer('death').notNull(),
  assist: integer('assist').notNull(),
  gold: integer('gold').notNull(),
  ccing: integer('ccing').notNull(),
  exp: integer('exp').notNull(),
  timePlayed: integer('time_played').notNull(),
  totalDamageChampions: integer('total_damage_champions').notNull(),
  totalDamageDealtToBuildings: integer('total_damage_dealt_to_buildings').notNull(),
  totalDamageTaken: integer('total_damage_taken').notNull(),
  visionScore: integer('vision_score').notNull(),
  visionBought: integer('vision_bought').notNull(),
  pentaKills: integer('penta_kills'),
  level: integer('level').notNull(),
  item0: integer('item0').notNull(),
  item1: integer('item1').notNull(),
  item2: integer('item2').notNull(),
  item3: integer('item3').notNull(),
  item4: integer('item4').notNull(),
  item5: integer('item5').notNull(),
  item6: integer('item6').notNull(),
  summonerSpell1: integer('summoner_spell_1'),
  summonerSpell2: integer('summoner_spell_2'),
  perk0: integer('perk0'),
  perk1: integer('perk1'),
  perk2: integer('perk2'),
  perk3: integer('perk3'),
  perk4: integer('perk4'),
  perk5: integer('perk5'),
  keyStoneId: integer('key_stone_id').notNull(),
  perkSubStyle: integer('perk_sub_style').notNull(),
  minionsKilled: integer('minions_killed'),
  neutralMinionsKilled: integer('neutral_minions_killed'),
  neutralMinionsKilledYourJungle: integer('neutral_minions_killed_your_jungle'),
  neutralMinionsKilledEnemyJungle: integer('neutral_minions_killed_enemy_jungle'),
  createDate: timestamp('create_date', { withTimezone: true }).notNull().defaultNow(),
  updateDate: timestamp('update_date', { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export type MatchParticipant = typeof matchParticipant.$inferSelect;
export type InsertMatchParticipant = typeof matchParticipant.$inferInsert;

export const guildMember = pgTable('guild_member', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  status: char('status', { length: 1 }).notNull().default('1'), // 1 가입 2 탈퇴
  account: varchar('account', { length: 64 })
    .notNull()
    .references(() => riotAccount.playerCode), // RiotAccount playerCode
  mainAccount: varchar('main_account', { length: 64 }),
  isMain: boolean('is_main').notNull().default(true),
  guildId: varchar('guild_id', { length: 128 }).notNull(),
  createDate: timestamp('create_date', { withTimezone: true }).notNull().defaultNow(),
  updateDate: timestamp('update_date', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export type GuildMember = typeof guildMember.$inferSelect;
export type InsertGuildMember = typeof guildMember.$inferInsert;

export const summonerSpell = pgTable('summoner_spell', {
  id: integer('id').primaryKey(),
  key: varchar('key', { length: 64 }).notNull(),
  name: varchar('name', { length: 64 }).notNull(),
  createDate: timestamp('create_date').notNull().defaultNow(),
  updateDate: timestamp('update_date')
    .defaultNow()
    .$onUpdate(() => new Date()),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export type SummonerSpell = typeof summonerSpell.$inferSelect;

export const perks = pgTable('perks', {
  id: integer('id').primaryKey(),
  key: varchar('key', { length: 64 }).notNull(),
  icon: varchar('icon', { length: 255 }).notNull(),
  name: varchar('name', { length: 64 }).notNull(),
  createDate: timestamp('create_date').notNull().defaultNow(),
  updateDate: timestamp('update_date')
    .defaultNow()
    .$onUpdate(() => new Date()),
  isDeleted: boolean('is_deleted').notNull().default(false),
});

export type Perks = typeof perks.$inferSelect;

// --- relations 정의 ---
export const guildMemberRelations = relations(guildMember, ({ one }) => ({
  // guildMember.account 컬럼이 riotAccount.playerCode 컬럼을 참조
  riotAccount: one(riotAccount, {
    fields: [guildMember.account],
    references: [riotAccount.playerCode],
  }),
}));

export const riotAccountRelations = relations(riotAccount, ({ many }) => ({
  // 하나의 RiotAccount는 여러 GuildMember에 속할 수 있음
  guildMembers: many(guildMember),
}));

/**
 * 멤버 권한 테이블
 * - adminNormal, adminSuper는 guild_id가 null (전역 권한)
 * - 나머지는 guild_id 필수 (길드 스코프 권한)
 */
export const discordMemberRole = pgTable(
  'discord_member_role',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: text('member_id')
      .notNull()
      .references(() => discordMember.id),
    role: varchar('role', { length: 32 }).notNull(),
    guildId: varchar('guild_id', { length: 128 }),
    createDate: timestamp('create_date', { withTimezone: true }).notNull().defaultNow(),
    updateDate: timestamp('update_date', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    isDeleted: boolean('is_deleted').notNull().default(false),
  },
  (table) => [unique('uq_member_guild').on(table.memberId, table.guildId)],
);

export type DiscordMemberRole = typeof discordMemberRole.$inferSelect;
export type InsertDiscordMemberRole = typeof discordMemberRole.$inferInsert;
