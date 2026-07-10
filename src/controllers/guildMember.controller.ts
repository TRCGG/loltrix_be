import { NextFunction, Request, Response } from 'express';
import {
  GuildMemberResponse,
  GuildMemberAccountResponse,
  LinkSubAccountRequest,
  SubAccountsAPIResponse,
  UpdateGuildMemberStatusRequest,
  MemberListAPIResponse,
  DiscordMemberRoleListAPIResponse,
  UpdateMemberRoleRequest,
  UpdateMemberRoleAPIResponse,
  GuildAuditLogListAPIResponse,
  GuildAuditLogType,
} from '../types/guildMember.js';
import { guildMemberService } from '../services/guildMember.service.js';
import { discordMemberRoleService } from '../services/discordMemberRole.service.js';
import { guildAuditLogService } from '../services/guildAuditLog.service.js';
import { BusinessError } from '../types/error.js';
import { AuthRequest } from '../middlewares/authHandler.js';

/**
 * @desc 길드 멤버 및 라이엇 계정 정보 통합 검색
 * @route GET /api/guildMember/:guildId/:riotName
 * @access Public
 */
export const searchGuildMembers = async (
  req: Request<
    { guildId: string; riotName: string },
    GuildMemberAccountResponse,
    Record<string, never>,
    { riotNameTag?: string; limit?: number }
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

    if (members.length < 1) {
      return res.status(404).json({
        status: 'error',
        message: 'Guild members not found',
        data: null,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Guild members retrieved successfully',
      data: members,
    });
  } catch (error) {
    console.error('Error searching guild members:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while searching guild members',
      data: null,
    });
  }
};

/**
 * @desc 길드 멤버 목록 조회 (활성/탈퇴/전체)
 * @route GET /api/guildMember/:guildId/members
 * @access Public
 */
export const getMembers = async (
  req: Request<
    { guildId: string },
    MemberListAPIResponse,
    never,
    { status?: string; page?: string; limit?: string }
  >,
  res: Response<MemberListAPIResponse>,
) => {
  try {
    const { guildId } = req.params;
    const { status = '1', page, limit } = req.query;

    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 50;

    const { result, totalCount } = await guildMemberService.findMembersByGuildId(
      guildId,
      status as '1' | '2' | 'all',
      pageNum,
      limitNum,
    );

    res.setHeader('X-Total-Count', totalCount.toString());
    res.setHeader('X-Page', pageNum.toString());
    res.setHeader('X-Limit', limitNum.toString());
    res.setHeader('X-Total-Pages', Math.ceil(totalCount / limitNum).toString());

    return res.status(200).json({
      status: 'success',
      message: 'Members retrieved successfully',
      data: result,
    });
  } catch (error) {
    console.error('Error retrieving members:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving members',
      data: null,
    });
  }
};

/**
 * @desc 멤버 관리 화면용 Discord 멤버 목록/검색 (길드 스코프 역할 포함)
 * @route GET /api/guildMember/:guildId/discord-members
 * @access guildManager 이상 (admin bypass)
 */
export const getGuildDiscordMembers = async (
  req: Request<
    { guildId: string },
    DiscordMemberRoleListAPIResponse,
    never,
    { search?: string; page?: string; limit?: string }
  >,
  res: Response<DiscordMemberRoleListAPIResponse>,
) => {
  try {
    const { guildId } = req.params;
    const { search, page, limit } = req.query;

    // zod 상한 검증과 별개로 방어적 클램프 (validateRequest는 transform 값을 전달하지 않음)
    const pageNum = Math.min(Number(page) || 1, 100000);
    const limitNum = Math.min(Number(limit) || 50, 1000);

    const { result, totalCount } = await discordMemberRoleService.getGuildMembersWithRoles(guildId, {
      search,
      page: pageNum,
      limit: limitNum,
    });

    res.setHeader('X-Total-Count', totalCount.toString());
    res.setHeader('X-Page', pageNum.toString());
    res.setHeader('X-Limit', limitNum.toString());
    res.setHeader('X-Total-Pages', Math.ceil(totalCount / limitNum).toString());

    return res.status(200).json({
      status: 'success',
      message: 'Discord members retrieved successfully',
      data: result,
    });
  } catch (error) {
    console.error('Error retrieving discord members:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving discord members',
      data: null,
    });
  }
};

/**
 * @desc 클랜관리 화면용 관리 로그 조회 (역할 부여/회수 + 리플 삭제, 최신순)
 * @route GET /api/guildMember/:guildId/audit-logs
 * @access guildManager 이상 (admin bypass)
 */
export const getGuildAuditLogs = async (
  req: Request<
    { guildId: string },
    GuildAuditLogListAPIResponse,
    never,
    { type?: string; page?: string; limit?: string }
  >,
  res: Response<GuildAuditLogListAPIResponse>,
) => {
  try {
    const { guildId } = req.params;
    const { type, page, limit } = req.query;

    // zod 상한 검증과 별개로 방어적 클램프 (validateRequest는 transform 값을 전달하지 않음)
    const pageNum = Math.min(Number(page) || 1, 100000);
    const limitNum = Math.min(Number(limit) || 50, 100);
    const typeFilter: GuildAuditLogType | 'all' =
      type === 'roleChange' || type === 'replayDelete' ? type : 'all';

    const { result, totalCount } = await guildAuditLogService.getGuildAuditLogs(guildId, {
      type: typeFilter,
      page: pageNum,
      limit: limitNum,
    });

    res.setHeader('X-Total-Count', totalCount.toString());
    res.setHeader('X-Page', pageNum.toString());
    res.setHeader('X-Limit', limitNum.toString());
    res.setHeader('X-Total-Pages', Math.ceil(totalCount / limitNum).toString());

    return res.status(200).json({
      status: 'success',
      message: 'Audit logs retrieved successfully',
      data: result,
    });
  } catch (error) {
    console.error('Error retrieving audit logs:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving audit logs',
      data: null,
    });
  }
};

/**
 * @desc 멤버 역할 부여/회수 (userNormal <-> userUploader)
 * @route PATCH /api/guildMember/:guildId/discord-members/:memberId/role
 * @access guildManager 이상 (admin bypass)
 */
export const updateGuildMemberRole = async (
  req: AuthRequest,
  res: Response<UpdateMemberRoleAPIResponse>,
) => {
  try {
    const { guildId, memberId } = req.params as { guildId: string; memberId: string };
    const { role } = req.body as UpdateMemberRoleRequest;
    // 요청 주체(actor). requireGuildRole이 non-bot의 discordMemberId 존재를 보장, bot은 bypass.
    const actorMemberId = req.discordMemberId ?? 'bot';

    const result = await discordMemberRoleService.grantOrRevokeRole(
      actorMemberId,
      guildId,
      memberId,
      role,
    );

    return res.status(200).json({
      status: 'success',
      message: result.changed
        ? `Role updated to ${result.role}`
        : `Role already ${result.role} (no change)`,
      data: result,
    });
  } catch (error) {
    if (error instanceof BusinessError) {
      return res.status(error.status).json({
        status: 'error',
        message: error.message,
        data: null,
      });
    }
    console.error('Error updating member role:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while updating member role',
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
  next: NextFunction,
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
    next(error);
  }
};

/**
 * @desc 특정 길드의 부계정 목록을 조회
 * @route GET /api/guildMember/:guildId/sub-accounts
 * @access Public
 */
export const getSubAccounts = async (
  req: Request<{ guildId: string }>,
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

    return res.status(200).json({
      status: 'success',
      message: 'Sub-accounts retrieved successfully',
      data: members,
    });
  } catch (error) {
    console.error('Error retrieving sub-accounts:', error);
    return res.status(500).json({
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
  req: Request<Record<string, never>, GuildMemberResponse, UpdateGuildMemberStatusRequest>,
  res: Response<GuildMemberResponse>,
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

    const updateMember = await guildMemberService.updateGuildMemberStatusByRiotId(
      guildId,
      riotName,
      riotNameTag,
      status,
    );

    const actionText = status === '1' ? 'restored' : 'withdrawn';

    return res.status(200).json({
      status: 'success',
      message: `Member and sub-accounts successfully ${actionText}.`,
      data: updateMember,
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

    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while updating member status',
      data: null,
    });
  }
};

/**
 * @desc 부계정 연결 해제 (부계정이 본계정과의 연결을 해제)
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
      riotNameTag,
    );

    if (!deleteSubAccount) {
      return res.status(404).json({
        status: 'error',
        message: 'Sub-account not found',
        data: null,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Sub-account link removed successfully.',
      data: deleteSubAccount,
    });
  } catch (error) {
    console.error('Error removing sub-account link:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while removing sub-account',
      data: null,
    });
  }
};
