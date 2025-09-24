// src/services/guild.service.ts
import { eq, ilike, desc, sql, and } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { guild, InsertGuild } from '../database/schema.js';
import { GetGuildsQuery, UpdateGuildRequest } from '../types/guild.js';

/**
 * @desc 새로운 길드를 데이터베이스에 생성
 */
export const insertGuild = async (newGuildData: InsertGuild) => {
  const result = await db.insert(guild).values(newGuildData).returning();
  return result[0];
};

/**
 * @desc ID로 길드 조회
 */
export const findGuildById = async (id: string) => {
  const result = await db
    .select()
    .from(guild)
    .where(and(eq(guild.id, id), eq(guild.isDeleted, false)))
    .limit(1);
  return result[0];
};

/**
 * @desc 모든 길드를 페이지네이션 및 검색 조건에 따라 조회
 */
export const findAllGuilds = async ({ page = 1, limit = 10, search }: GetGuildsQuery) => {
  const offset = (Number(page) - 1) * Number(limit);
  const baseCondition = eq(guild.isDeleted, false);
  const whereCondition = search
    ? and(baseCondition, ilike(guild.name, `%${search}%`))
    : baseCondition;

  const result = await db
    .select()
    .from(guild)
    .where(whereCondition)
    .orderBy(desc(guild.createDate))
    .limit(Number(limit))
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(guild)
    .where(whereCondition);

  const totalCount = countResult[0]?.count || 0;

  return { result, totalCount };
};

/**
 * @desc ID로 길드 정보 수정
 */
export const updateGuild = async (id: string, updateData: UpdateGuildRequest) => {
  const result = await db
    .update(guild)
    .set(updateData)
    .where(and(eq(guild.id, id), eq(guild.isDeleted, false)))
    .returning();
  return result[0];
};

/**
 * @desc ID로 길드 논리적 삭제
 */
export const softDeleteGuild = async (id: string) => {
  const result = await db
    .update(guild)
    .set({ isDeleted: true })
    .where(eq(guild.id, id))
    .returning();
  return result[0];
};