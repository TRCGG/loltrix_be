import { Request, Response } from 'express';
import { eq, ilike, desc, sql, and } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { guild } from '../database/schema.js';
import {
  CreateGuildRequest,
  UpdateGuildRequest,
  GetGuildsQuery,
  GuildResponse,
} from '../types/guild.js';

/**
 * @desc 새로운 길드 생성
 * @route POST /api/guilds
 * @access Public
 */
export const createGuild = async (
  req: Request<Record<string, never>, GuildResponse, CreateGuildRequest>,
  res: Response<GuildResponse>,
) => {
  try {
    const { guildId, guildName, lanId } = req.body;

    const newGuild = await db
      .insert(guild)
      .values({
        guildId,
        guildName,
        lanId,
      })
      .returning();

    res.status(201).json({
      status: 'success',
      message: 'Guild created successfully',
      data: newGuild[0],
    });
  } catch (error) {
    console.error('Error creating guild:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while creating guild',
      data: null,
    });
  }
};

/**
 * @desc ID로 길드 조회
 * @route GET /api/guilds/:id
 * @access Public
 */
export const getGuildById = async (
  req: Request<{ guildId: string }>,
  res: Response<GuildResponse>,
) => {
  try {
    const { guildId } = req.params;

    const guildResult = await db
      .select()
      .from(guild)
      .where(and(eq(guild.guildId, guildId), eq(guild.deleteYn, 'N')))
      .limit(1);

    if (guildResult.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Guild not found',
        data: null,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Guild retrieved successfully',
      data: guildResult[0],
    });
  } catch (error) {
    console.error('Error retrieving guild:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving guild',
      data: null,
    });
  }
};

/**
 * @desc 페이지네이션과 검색으로 모든 길드 조회
 * @route GET /api/guilds
 * @access Public
 */
export const getAllGuilds = async (
  req: Request<Record<string, never>, GuildResponse, Record<string, never>, GetGuildsQuery>,
  res: Response<GuildResponse>,
) => {
  try {
    const { page = 1, limit = 10, search } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    // Build the query with conditions
    const baseCondition = eq(guild.deleteYn, 'N');
    const whereCondition = search
      ? and(baseCondition, ilike(guild.guildName, `%${search}%`))
      : baseCondition;

    // Execute query with all conditions
    const result = await db
      .select()
      .from(guild)
      .where(whereCondition)
      .orderBy(desc(guild.createDate))
      .limit(Number(limit))
      .offset(offset);

    // Get total count for pagination info
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(guild)
      .where(whereCondition);

    const totalCount = countResult[0]?.count || 0;

    res.status(200).json({
      status: 'success',
      message: 'Guilds retrieved successfully',
      data: result,
    });

    // Add pagination headers
    res.setHeader('X-Total-Count', totalCount.toString());
    res.setHeader('X-Page', page.toString());
    res.setHeader('X-Limit', limit.toString());
    res.setHeader('X-Total-Pages', Math.ceil(totalCount / Number(limit)).toString());
  } catch (error) {
    console.error('Error retrieving guilds:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving guilds',
      data: null,
    });
  }
};

/**
 * @desc ID로 길드 수정
 * @route PUT /api/guilds/:id
 * @access Public
 */
export const updateGuild = async (
  req: Request<{ guildId: string }, GuildResponse, UpdateGuildRequest>,
  res: Response<GuildResponse>,
) => {
  try {
    const { guildId } = req.params;
    const updateData = req.body;

    // Check if guild exists
    const existingGuild = await db
      .select()
      .from(guild)
      .where(and(eq(guild.guildId, guildId), eq(guild.deleteYn, 'N')))
      .limit(1);

    if (existingGuild.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Guild not found',
        data: null,
      });
    }

    // Update the guild
    const updatedGuild = await db
      .update(guild)
      .set(updateData)
      .where(eq(guild.guildId, guildId))
      .returning();

    return res.status(200).json({
      status: 'success',
      message: 'Guild updated successfully',
      data: updatedGuild[0],
    });
  } catch (error) {
    console.error('Error updating guild:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while updating guild',
      data: null,
    });
  }
};

/**
 * @desc ID로 길드 삭제 (소프트 삭제)
 * @route DELETE /api/guilds/:guildId
 * @access Public
 */
export const deleteGuild = async (
  req: Request<{ guildId: string }>,
  res: Response<GuildResponse>,
) => {
  try {
    const { guildId } = req.params;

    // Check if guild exists and is not already deleted
    const existingGuild = await db
      .select()
      .from(guild)
      .where(and(eq(guild.guildId, guildId), eq(guild.deleteYn, 'N')))
      .limit(1);

    if (existingGuild.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Guild not found',
        data: null,
      });
    }

    // Soft delete the guild
    const deletedGuild = await db
      .update(guild)
      .set({ deleteYn: 'Y' })
      .where(eq(guild.guildId, guildId))
      .returning();

    return res.status(200).json({
      status: 'success',
      message: 'Guild deleted successfully',
      data: deletedGuild[0],
    });
  } catch (error) {
    console.error('Error deleting guild:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while deleting guild',
      data: null,
    });
  }
};
