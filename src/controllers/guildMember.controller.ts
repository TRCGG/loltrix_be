import { Request, Response } from 'express';
import {
  GuildMemberResponse, 
  GuildMemberAccountResponse, 
  LinkSubAccountRequest,
  SubAccountsAPIResponse,
  UpdateGuildMemberStatusRequest,
} from '../types/guildMember.js'; // 타입 경로 수정 필요
import { guildMemberService } from '../services/guildMember.service.js';
import { BusinessError } from '../types/error.js';

/**
 * @desc 길드 멤버 및 라이엇 계정 정보 통합 검색
 * @route GET /api/guildMember/:guildId/:riotName
 * @access Public
 */
export const searchGuildMembers = async (
  req: Request<
    { guildId: string, riotName: string },
    GuildMemberAccountResponse,   
    Record<string, never>, 
    { riotNameTag?: string, limit?: number}    
  >,
  res: Response<GuildMemberAccountResponse>,
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

/**
 * @desc 길드 멤버 상태 변경 (활동/탈퇴) - 부캐 포함
 * @route PUT /api/guildMember/status
 * @access Public
 */
export const updateMemberStatus = async (
  req: Request<
    Record<string, never>,
    GuildMemberResponse,
    UpdateGuildMemberStatusRequest
  >,
  res: Response<GuildMemberResponse>
) => {
  try {
    const { guildId, riotName, riotNameTag, status } = req.body;

    // 간단한 유효성 검사
    if (status !== '1' && status !== '2') {
      return res.status(400).json({
        status: 'error',
        message: "Status must be '1' (Active) or '2' (Withdrawn)",
        data: null,
      });
    }

    await guildMemberService.updateGuildMemberStatusByRiotId(
      guildId,
      riotName,
      riotNameTag,
      status
    );

    const actionText = status === '1' ? 'restored' : 'withdrawn';

    res.status(200).json({
      status: 'success',
      message: `Member and sub-accounts successfully ${actionText}.`,
      data: null,
    });

  } catch (error) {
    console.error('Error updating member status:', error);

    if (error instanceof BusinessError) {
      return res.status(error.status).json({
        status: 'error',
        message: error.message,
        data: null,
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Internal server error while updating member status',
      data: null,
    });
  }
};

/**
 * @desc 부계정 연결 해제 (Hard Delete)
 * @route DELETE /api/guildMember/sub-account
 * @access Public
 */
export const removeSubAccount = async (
  req: Request<
    Record<string, never>,
    GuildMemberResponse,
    { guildId: string; riotName: string; riotNameTag: string }
  >,
  res: Response<GuildMemberResponse>,
) => {
  try {
    const { guildId, riotName, riotNameTag } = req.body;

    const deleteSubAccount = await guildMemberService.deleteSubAccountByRiotId(
      guildId,
      riotName,
      riotNameTag
    );

    if(!deleteSubAccount) {
      return res.status(404).json({
        status: 'error',
        message: 'Sub-account not found',
        data: null,
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Sub-account removed successfully.',
      data: deleteSubAccount,
    });

  } catch (error) {
    console.error('Error removing sub-account:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while removing sub-account',
      data: null,
    });
  }
};