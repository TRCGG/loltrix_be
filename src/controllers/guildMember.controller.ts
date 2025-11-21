import { Request, Response } from 'express';
import {
  GuildMemberResponse, 
  GuildMemberWithRiotAccountResponse, 
  LinkSubAccountRequest,
  SubAccountsAPIResponse,
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
    GuildMemberWithRiotAccountResponse,   
    Record<string, never>, 
    { riotNameTag?: string, limit?: number}    
  >,
  res: Response<GuildMemberWithRiotAccountResponse>,
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

/**
 * @desc 부계정을 본계정에 연결하고 DB 정보 업데이트 
 * @route POST /api/guildMember/sub-account
 * @access Public
 */
export const linkSubAccount = async (
  req: Request<
    Record<string, never>, 
    GuildMemberResponse, 
    LinkSubAccountRequest,
    Record<string, never>
  >,
  res: Response<GuildMemberResponse>,
) => {
  try {
    const { guildId, subRiotName, subRiotTag, mainRiotName, mainRiotTag } = req.body;

    const resultGuildMember = await guildMemberService.linkSubAccount({
      guildId,
      subRiotName,
      subRiotTag,
      mainRiotName,
      mainRiotTag,
    });

    res.status(200).json({
      status: 'success',
      message: 'Sub-account linked successfully to primary account.',
      data: resultGuildMember,
    });

  } catch (error) {
    console.error('Error linking sub-account:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while linking sub-account',
      data: null,
    });
  }
};

/**
 * @desc 특정 길드의 부계정 목록을 조회
 * @route GET /api/guildMember/:guildId/sub-accounts
 * @access Public
 */
export const getSubAccounts = async (
  req: Request<{guildId: string }>,
  res: Response<SubAccountsAPIResponse>,
) => {
  try {
    const { guildId } = req.params;

    const members = await guildMemberService.findSubAccountsByGuildId(guildId);

    if (members.length < 1) {
      return res.status(200).json({
        status: 'success',
        message: 'No sub-accounts found for this guild.',
        data: [], 
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Sub-accounts retrieved successfully',
      data: members,
    });

  } catch (error) {
    console.error('Error retrieving sub-accounts:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving sub-accounts',
      data: null,
    });
  }
};