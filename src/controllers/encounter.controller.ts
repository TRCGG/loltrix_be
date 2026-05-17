import { Request, Response } from 'express';
import { encounterService } from '../services/encounter.service.js';
import { guildMemberService } from '../services/guildMember.service.js';
import { systemConfigService } from '../services/systemConfig.service.js';
import {
  EncounterResponse,
  EncounterSummary,
  EncounterGamesResult,
  FrequentOpponentsResult,
  MemberCandidate,
} from '../types/encounter.js';

/**
 * @desc riotName/riotNameTag로 길드 멤버를 조회하고 단일 playerCode 반환
 * 멤버를 찾지 못하면 null, 여러 명이면 후보 목록 반환
 */
async function resolveSingleMember(
  guildId: string,
  riotName: string,
  riotNameTag?: string,
): Promise<
  | { playerCode: string; riotName: string; riotNameTag: string }
  | { candidates: { playerCode: string; riotName: string; riotNameTag: string }[] }
  | null
> {
  const members = await guildMemberService.searchGuildMemberByRiotId(guildId, {
    riotName,
    riotNameTag,
  });

  if (!members || members.length === 0) return null;

  if (members.length > 1) {
    return {
      candidates: members.map((m) => ({
        playerCode: m.playerCode,
        riotName: m.riotName,
        riotNameTag: m.riotNameTag,
      })),
    };
  }

  return {
    playerCode: members[0].playerCode,
    riotName: members[0].riotName,
    riotNameTag: members[0].riotNameTag,
  };
}

/**
 * @desc 상대 전적 종합 요약 조회
 * @route GET /api/encounter/:guildId/summary
 */
export const getEncounterSummary = async (
  req: Request<{ guildId: string }>,
  res: Response<EncounterResponse<EncounterSummary>>,
) => {
  try {
    const { guildId } = req.params;
    const { riotName1, riotNameTag1, riotName2, riotNameTag2, season, matchupPosition } = req.query as {
      riotName1: string;
      riotNameTag1?: string;
      riotName2: string;
      riotNameTag2?: string;
      season?: string;
      matchupPosition?: 'ALL' | 'TOP' | 'JUG' | 'MID' | 'ADC' | 'SUP';
    };

    const defaultSeason = await systemConfigService.getConfigOrDefault('LOL_SEASON', 'error_season');
    const lolSeason = season || defaultSeason;

    const [resultA, resultB] = await Promise.all([
      resolveSingleMember(guildId, riotName1, riotNameTag1),
      resolveSingleMember(guildId, riotName2, riotNameTag2),
    ]);

    if (!resultA) {
      return res.status(404).json({ status: 'error', message: `${riotName1} 멤버를 찾을 수 없습니다.`, data: null });
    }
    if (!resultB) {
      return res.status(404).json({ status: 'error', message: `${riotName2} 멤버를 찾을 수 없습니다.`, data: null });
    }

    if ('candidates' in resultA) {
      return res.status(200).json({ status: 'error', message: `${riotName1} 후보가 여러 명입니다.`, data: resultA.candidates as MemberCandidate[] });
    }
    if ('candidates' in resultB) {
      return res.status(200).json({ status: 'error', message: `${riotName2} 후보가 여러 명입니다.`, data: resultB.candidates as MemberCandidate[] });
    }

    if (resultA.playerCode === resultB.playerCode) {
      return res.status(400).json({ status: 'error', message: '같은 플레이어끼리는 비교할 수 없습니다.', data: null });
    }

    const rawGames = await encounterService.getEncounterRawGames(
      resultA.playerCode,
      resultB.playerCode,
      guildId,
      lolSeason,
    );

    const summary = encounterService.buildEncounterSummary(rawGames, resultA, resultB, matchupPosition ?? 'ALL');

    return res.status(200).json({
      status: 'success',
      message: 'Encounter summary retrieved successfully',
      data: summary,
    });
  } catch (error) {
    console.error('Error retrieving encounter summary:', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error', data: null });
  }
};

/**
 * @desc 상대 전적 경기 기록 목록 조회 (scenario 필터 + 페이지네이션)
 * @route GET /api/encounter/:guildId/games
 */
export const getEncounterGames = async (
  req: Request<{ guildId: string }>,
  res: Response<EncounterResponse<EncounterGamesResult>>,
) => {
  try {
    const { guildId } = req.params;
    const { riotName1, riotNameTag1, riotName2, riotNameTag2, season, scenario, page, limit } =
      req.query as {
        riotName1: string;
        riotNameTag1?: string;
        riotName2: string;
        riotNameTag2?: string;
        season?: string;
        scenario?: 'all' | 'enemies' | 'allies';
        page?: string;
        limit?: string;
      };

    const defaultSeason = await systemConfigService.getConfigOrDefault('LOL_SEASON', 'error_season');
    const lolSeason = season || defaultSeason;

    const [resultA, resultB] = await Promise.all([
      resolveSingleMember(guildId, riotName1, riotNameTag1),
      resolveSingleMember(guildId, riotName2, riotNameTag2),
    ]);

    if (!resultA) {
      return res.status(404).json({ status: 'error', message: `${riotName1} 멤버를 찾을 수 없습니다.`, data: null });
    }
    if (!resultB) {
      return res.status(404).json({ status: 'error', message: `${riotName2} 멤버를 찾을 수 없습니다.`, data: null });
    }

    if ('candidates' in resultA) {
      return res.status(200).json({ status: 'error', message: `${riotName1} 후보가 여러 명입니다.`, data: resultA.candidates as MemberCandidate[] });
    }
    if ('candidates' in resultB) {
      return res.status(200).json({ status: 'error', message: `${riotName2} 후보가 여러 명입니다.`, data: resultB.candidates as MemberCandidate[] });
    }

    if (resultA.playerCode === resultB.playerCode) {
      return res.status(400).json({ status: 'error', message: '같은 플레이어끼리는 비교할 수 없습니다.', data: null });
    }

    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 20;

    const rawGames = await encounterService.getEncounterRawGames(
      resultA.playerCode,
      resultB.playerCode,
      guildId,
      lolSeason,
    );

    const result = encounterService.getEncounterGames(rawGames, scenario ?? 'all', pageNum, limitNum);

    res.setHeader('X-Total-Count', result.totalCount.toString());
    res.setHeader('X-Page', pageNum.toString());
    res.setHeader('X-Limit', limitNum.toString());
    res.setHeader('X-Total-Pages', Math.ceil(result.totalCount / limitNum).toString());

    return res.status(200).json({
      status: 'success',
      message: 'Encounter games retrieved successfully',
      data: result,
    });
  } catch (error) {
    console.error('Error retrieving encounter games:', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error', data: null });
  }
};

/**
 * @desc 자주 만난 상대 목록 조회
 * @route GET /api/encounter/:guildId/frequent
 */
export const getFrequentOpponents = async (
  req: Request<{ guildId: string }>,
  res: Response<EncounterResponse<FrequentOpponentsResult>>,
) => {
  try {
    const { guildId } = req.params;
    const { riotName, riotNameTag, season, period, sortBy, page, limit } = req.query as {
      riotName: string;
      riotNameTag?: string;
      season?: string;
      period?: 'recent' | 'all';
      sortBy?: 'totalGames' | 'winRate';
      page?: string;
      limit?: string;
    };

    const defaultSeason = await systemConfigService.getConfigOrDefault('LOL_SEASON', 'error_season');
    const lolSeason = season || defaultSeason;

    const result = await resolveSingleMember(guildId, riotName, riotNameTag);

    if (!result) {
      return res.status(404).json({ status: 'error', message: '멤버를 찾을 수 없습니다.', data: null });
    }

    if ('candidates' in result) {
      return res.status(200).json({ status: 'error', message: '후보가 여러 명입니다.', data: result.candidates as MemberCandidate[] });
    }

    const data = await encounterService.getFrequentOpponents(result.playerCode, guildId, {
      riotName,
      riotNameTag,
      season: lolSeason,
      period,
      sortBy,
      page,
      limit,
    });

    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 20;

    res.setHeader('X-Total-Count', data.totalCount.toString());
    res.setHeader('X-Page', pageNum.toString());
    res.setHeader('X-Limit', limitNum.toString());
    res.setHeader('X-Total-Pages', Math.ceil(data.totalCount / limitNum).toString());

    return res.status(200).json({
      status: 'success',
      message: 'Frequent opponents retrieved successfully',
      data,
    });
  } catch (error) {
    console.error('Error retrieving frequent opponents:', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error', data: null });
  }
};
