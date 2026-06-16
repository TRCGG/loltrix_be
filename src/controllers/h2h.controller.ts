import { Request, Response } from 'express';
import { h2hService } from '../services/h2h.service.js';
import { guildMemberService } from '../services/guildMember.service.js';
import { systemConfigService } from '../services/systemConfig.service.js';
import { H2hResponse, FrequentH2hItem, MemberCandidate, H2hDetail } from '../types/h2h.js';

/**
 * @desc riotName/riotNameTag로 길드 멤버를 조회하고 단일 playerCode 반환
 * 멤버를 찾지 못하면 null, 여러 명이면 후보 목록 반환 (기존 encounter 방식과 동일)
 */
async function resolveSingleMember(
  guildId: string,
  riotName: string,
  riotNameTag?: string,
): Promise<
  | { playerCode: string; riotName: string; riotNameTag: string }
  | { candidates: MemberCandidate[] }
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

/** @desc season 파라미터 해석: 미입력 → 현재 시즌(LOL_SEASON), 'all' → 전체(null) */
async function resolveSeasonValue(season?: string): Promise<string | null> {
  if (season === 'all') return null;
  if (season) return season;
  return systemConfigService.getConfigOrDefault('LOL_SEASON', 'error_season');
}

/**
 * @desc 자주 만난 상대 목록 조회 (맞붙은 게임 수 기준, 시즌)
 * @route GET /api/h2h/:guildId/frequent
 */
export const getFrequentOpponents = async (
  req: Request<{ guildId: string }>,
  res: Response<H2hResponse<FrequentH2hItem[]>>,
) => {
  try {
    const { guildId } = req.params;
    const { riotName, riotNameTag, q, limit, season } = req.query as {
      riotName: string;
      riotNameTag?: string;
      q?: string;
      limit?: string;
      season?: string;
    };

    const meResult = await resolveSingleMember(guildId, riotName, riotNameTag);

    if (!meResult) {
      return res
        .status(404)
        .json({ status: 'error', message: `${riotName} 멤버를 찾을 수 없습니다.`, data: null });
    }

    if ('candidates' in meResult) {
      return res.status(200).json({
        status: 'error',
        message: `${riotName} 후보가 여러 명입니다.`,
        data: meResult.candidates,
      });
    }

    const seasonValue = await resolveSeasonValue(season);

    const data = await h2hService.getFrequentOpponents(guildId, meResult.playerCode, {
      q,
      limit,
      season: seasonValue,
    });

    return res.status(200).json({
      status: 'success',
      message: 'Frequent opponents retrieved successfully',
      data,
    });
  } catch (error) {
    console.error('Error retrieving frequent opponents (h2h):', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error', data: null });
  }
};

/**
 * @desc 두 유저 상대전적 상세 (against 블록)
 * @route GET /api/h2h/:guildId
 */
export const getH2hDetail = async (
  req: Request<{ guildId: string }>,
  res: Response<H2hResponse<H2hDetail>>,
) => {
  try {
    const { guildId } = req.params;
    const { riotName1, riotNameTag1, riotName2, riotNameTag2, season, recentLimit, recentOffset } =
      req.query as {
        riotName1: string;
        riotNameTag1?: string;
        riotName2: string;
        riotNameTag2?: string;
        season?: string;
        recentLimit?: string;
        recentOffset?: string;
      };

    const [resultA, resultB] = await Promise.all([
      resolveSingleMember(guildId, riotName1, riotNameTag1),
      resolveSingleMember(guildId, riotName2, riotNameTag2),
    ]);

    if (!resultA) {
      return res
        .status(404)
        .json({ status: 'error', message: `${riotName1} 멤버를 찾을 수 없습니다.`, data: null });
    }
    if (!resultB) {
      return res
        .status(404)
        .json({ status: 'error', message: `${riotName2} 멤버를 찾을 수 없습니다.`, data: null });
    }
    if ('candidates' in resultA) {
      return res.status(200).json({
        status: 'error',
        message: `${riotName1} 후보가 여러 명입니다.`,
        data: resultA.candidates,
      });
    }
    if ('candidates' in resultB) {
      return res.status(200).json({
        status: 'error',
        message: `${riotName2} 후보가 여러 명입니다.`,
        data: resultB.candidates,
      });
    }
    if (resultA.playerCode === resultB.playerCode) {
      return res
        .status(400)
        .json({ status: 'error', message: '같은 플레이어끼리는 비교할 수 없습니다.', data: null });
    }

    const seasonValue = await resolveSeasonValue(season);

    const data = await h2hService.getH2hDetail(guildId, resultA.playerCode, resultB.playerCode, {
      season: seasonValue,
      recentLimit: Number(recentLimit) || 6,
      recentOffset: Number(recentOffset) || 0,
    });

    return res.status(200).json({
      status: 'success',
      message: 'H2H detail retrieved successfully',
      data,
    });
  } catch (error) {
    console.error('Error retrieving h2h detail:', error);
    return res.status(500).json({ status: 'error', message: 'Internal server error', data: null });
  }
};
