import { Request, Response } from 'express';
import {
  CreateGuildRequest,
  UpdateGuildRequest,
  GetGuildsQuery,
  GuildResponse,
} from '../types/guild.js';
import * as GuildService from '../services/guild.service.js';

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
    const { guildId, guildName, languageCode } = req.body;

    const newGuild = await GuildService.insertGuild({
      id: guildId,
      name: guildName,
      languageCode,
    });

    res.status(201).json({
      status: 'success',
      message: 'Guild created successfully',
      data: newGuild,
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
  req: Request<{ id: string }>,
  res: Response<GuildResponse>,
) => {
  try {
    const { id } = req.params;

    const guildResult = await GuildService.findGuildById(id);

    if (!guildResult) {
      return res.status(404).json({
        status: 'error',
        message: 'Guild not found',
        data: null,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Guild retrieved successfully',
      data: guildResult,
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
    const { page, limit, search } = req.query;

    const { result, totalCount } = await GuildService.findAllGuilds({ page, limit, search });

    res.status(200).json({
      status: 'success',
      message: 'Guilds retrieved successfully',
      data: result,
    });

    res.setHeader('X-Total-Count', totalCount.toString());
    res.setHeader('X-Page', (page ?? 1).toString());
    res.setHeader('X-Limit', (limit ?? 10).toString());
    res.setHeader('X-Total-Pages', Math.ceil(totalCount / (Number(limit) ?? 10)).toString());
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
  req: Request<{ id: string }, GuildResponse, UpdateGuildRequest>,
  res: Response<GuildResponse>,
) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const updatedGuild = await GuildService.updateGuild(id, updateData);

    if (!updatedGuild) {
      return res.status(404).json({
        status: 'error',
        message: 'Guild not found or not able to be updated',
        data: null,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Guild updated successfully',
      data: updatedGuild,
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
 * @route DELETE /api/guilds/:id
 * @access Public
 */
export const deleteGuild = async (
  req: Request<{ id: string }>,
  res: Response<GuildResponse>,
) => {
  try {
    const { id } = req.params;

    const deletedGuild = await GuildService.softDeleteGuild(id);

    if (!deletedGuild) {
      return res.status(404).json({
        status: 'error',
        message: 'Guild not found or already deleted',
        data: null,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Guild deleted successfully',
      data: deletedGuild,
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