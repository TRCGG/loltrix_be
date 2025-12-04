// controllers/matchParticipant.controller.ts
import { Request, Response } from 'express';
import {
  MatchResponse,
  MatchQuery,
  RecentGame,
  DashboardData,
  MostPick,
} from '../types/matchParticipant.js';
import { matchParticipantService } from '../services/matchParticipant.service.js';
import { guildMemberService } from '../services/guildMember.service.js';
import { BusinessError } from '../types/error.js';

const envLoLSeason = process.env.LOL_SEASON || "2026";

const formatMember = (members: any[]) => {
  const formattedMembers = members.map((member) => ({
    playerCode: member.riot_account.playerCode,
    riotName: member.riot_account.riotName,
    riotNameTag: member.riot_account.riotNameTag,
  }));
  return formattedMembers;
};

/**
 * @desc 최근 게임 목록 상세 조회 (페이지네이션)
 * @route GET /api/matches/:guildId/:riotName/games
 * @access Public
 */
export const getRecentGames = async (
  req: Request<
    { guildId: string; riotName: string },
    MatchResponse<RecentGame[]>,
    Record<string, never>,
    MatchQuery
  >,
  res: Response<MatchResponse<RecentGame[]>>,
) => {
  try {
    const { guildId, riotName } = req.params;
    const { riotNameTag, season, page, limit } = req.query;

    const lolSeason = season ? season : envLoLSeason;

    const members = await guildMemberService.searchGuildMemberByRiotId(guildId, {
      riotName,
      riotNameTag,
    });

    if (!members || members.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'guild member not found',
        data: null,
      });
    }

    if (members.length > 1) {
      const formattedMembers = formatMember(members);
      return res.status(200).json({
        status: 'success',
        message: 'Multiple members found',
        data: formattedMembers,
      });
    }

    const playerCode = members[0].riot_account.playerCode;

    const games = await matchParticipantService.getRecentGamesByRiotName(
      playerCode,
      lolSeason,
      Number(page) || 1,
      Number(limit) || 20,
    );

    return res.status(200).json({
      status: 'success',
      message: 'Recent games retrieved successfully',
      data: games,
    });
  } catch (error) {
    console.error('Error retrieving recent games:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving recent games',
      data: null,
    });
  }
};

/**
 * @desc 전적 대시보드 데이터 조회 (요약 + 라인별 + 모스트)
 * @route GET /api/matches/:guildId/:riotName/dashboard
 * @access Public
 */
export const getMatchDashboard = async (
  req: Request<
    { guildId: string; riotName: string },
    MatchResponse<DashboardData>,
    Record<string, never>,
    MatchQuery
  >,
  res: Response<MatchResponse<DashboardData>>,
) => {
  try {
    const { guildId, riotName } = req.params;
    const { riotNameTag, season } = req.query;

    const lolSeason = season ? season : envLoLSeason;

    const members = await guildMemberService.searchGuildMemberByRiotId(guildId, {
      riotName,
      riotNameTag,
    });
    if (!members || members.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'guild member not found',
        data: null,
      });
    }

    if (members.length > 1) {
      const formattedMembers = formatMember(members);
      return res.status(200).json({
        status: 'success',
        message: 'Multiple members found',
        data: formattedMembers,
      });
    }

    const playerCode = members[0].riot_account.playerCode;

    const [monthRecord, lineRecord, mostPicks] = await Promise.all([
      matchParticipantService.getRecentMonthRecord(playerCode),
      matchParticipantService.getLineRecord(playerCode, lolSeason),
      matchParticipantService.getMostPicks(playerCode, lolSeason, 1, 10),
    ]);

    res.status(200).json({
      status: 'success',
      message: 'Match dashboard data retrieved successfully',
      data: {
        summary: monthRecord,
        lines: lineRecord,
        mostPicks: mostPicks,
      },
    });
  } catch (error) {
    console.error('Error retrieving match dashboard:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving match dashboard',
      data: null,
    });
  }
};

/**
 * @desc 모스트 픽 상세 목록 조회 (페이징 가능)
 * @route GET /api/matches/:guildId/:riotName/most-picks
 * @access Public
 */
export const getMostPicks = async (
  req: Request<
    { guildId: string; riotName: string },
    MatchResponse<MostPick[]>,
    Record<string, never>,
    MatchQuery
  >,
  res: Response<MatchResponse<MostPick[]>>,
) => {
  try {
    const { guildId, riotName } = req.params;
    const { riotNameTag, season, page, limit } = req.query;

    const lolSeason = season ? season : envLoLSeason;

    const members = await guildMemberService.searchGuildMemberByRiotId(guildId, {
      riotName,
      riotNameTag,
    });

    if (!members || members.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'guild member not found',
        data: null,
      });
    }

    if (members.length > 1) {
      const formattedMembers = formatMember(members);
      return res.status(200).json({
        status: 'success',
        message: 'Multiple members found',
        data: formattedMembers,
      });
    }

    const playerCode = members[0].riot_account.playerCode;

    const result = await matchParticipantService.getMostPicks(
      playerCode,
      lolSeason,
      Number(page) || 1,
      Number(limit) || 10,
    );

    res.status(200).json({
      status: 'success',
      message: 'Most picks retrieved successfully',
      data: result,
    });
  } catch (error) {
    console.error('Error retrieving most picks:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving most picks',
      data: null,
    });
  }
};
