import { Request, Response } from 'express';
import {
  GuildMemberResponse, 
} from '../types/guildMember.js'; // 타입 경로 수정 필요
import { guildMemberService } from '../services/guildMember.service.js';

/**
 * @desc 길드 멤버 및 라이엇 계정 정보 통합 검색
 * @route GET /api/guildMember/:guildId/:riotName
 * @access Public
 */
export const searchGuildMembers = async (
  req: Request<
    { guildId: string, riotName: string },
    GuildMemberResponse,   
    Record<string, never>, 
    { riotNameTag?: string, limit?: number}    
  >,
  res: Response<GuildMemberResponse>,
) => {
  try {
    const { guildId, riotName } = req.params;
    const { riotNameTag, limit } = req.query;

    const members = await guildMemberService.searchGuildMemberByRiotId(guildId, {
      riotName,
      riotNameTag,
      limit,
    });

    if(members.length < 1) {
      return res.status(404).json({
        status: 'error',
        message: 'Guild members not found',
        data: null
      })
    }

    res.status(200).json({
      status: 'success',
      message: 'Guild members retrieved successfully',
      data: members,
    });
  } catch (error) {
    console.error('Error searching guild members:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while searching guild members',
      data: null,
    });
  }
};