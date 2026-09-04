import { NextFunction, Response } from 'express';
import { AuthRequest } from '../middlewares/authHandler.js';
import { BusinessError } from '../types/error.js';
import { competitionService } from '../services/competition.service.js';
import { competitionTeamService } from '../services/competitionTeam.service.js';
import {
  CompetitionActor,
  CompetitionApplicationItem,
  CompetitionApplicationStatus,
  CompetitionApplyInput,
  CompetitionCreateInput,
  CompetitionDetail,
  CompetitionHeadToHeadResult,
  CompetitionMatchTeamItem,
  CompetitionResolveResult,
  CompetitionResponse,
  CompetitionStatus,
  CompetitionSummary,
  CompetitionTeamRecordItem,
  CompetitionTeamUpdateInput,
  CompetitionTeamWithRoster,
  CompetitionUpdateInput,
} from '../types/competition.js';
import {
  Competition,
  CompetitionApplication,
  CompetitionMatchTeam,
  CompetitionTeam,
  CompetitionTeamMember,
} from '../database/schema.js';

/**
 * 행위자: 웹은 세션 memberId, 봇은 body.actorMemberId(명령 사용자) — 미전달이면 'bot'.
 * 봇 요청은 requireGuildRole을 통과하므로 권한 검사는 봇이 책임진다.
 */
const resolveActor = (req: AuthRequest): CompetitionActor => {
  const bodyActor = (req.body as { actorMemberId?: unknown } | undefined)?.actorMemberId;
  return req.isBot
    ? { memberId: typeof bodyActor === 'string' && bodyActor ? bodyActor : 'bot', source: 'bot' }
    : { memberId: req.discordMemberId ?? 'unknown', source: 'web' };
};

/** @route POST /api/competitions/:guildId */
export const createCompetition = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<Competition>>,
  next: NextFunction,
) => {
  try {
    const { guildId } = req.params as { guildId: string };
    const created = await competitionService.create(
      guildId,
      req.body as CompetitionCreateInput,
      resolveActor(req),
    );
    return res
      .status(201)
      .json({ status: 'success', message: 'Competition created successfully', data: created });
  } catch (error) {
    return next(error);
  }
};

/** @route PATCH /api/competitions/:guildId/:competitionId */
export const updateCompetition = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<Competition>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const updated = await competitionService.update(
      guildId,
      Number(competitionId),
      req.body as CompetitionUpdateInput,
      resolveActor(req),
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Competition updated successfully', data: updated });
  } catch (error) {
    return next(error);
  }
};

/** @route PATCH /api/competitions/:guildId/:competitionId/status */
export const changeCompetitionStatus = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<Competition>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const { status } = req.body as { status: CompetitionStatus };
    const updated = await competitionService.changeStatus(
      guildId,
      Number(competitionId),
      status,
      resolveActor(req),
    );
    return res
      .status(200)
      .json({
        status: 'success',
        message: 'Competition status changed successfully',
        data: updated,
      });
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/competitions/:guildId */
export const listCompetitions = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionSummary[]>>,
  next: NextFunction,
) => {
  try {
    const { guildId } = req.params as { guildId: string };
    const { season, status } = req.query as { season?: string; status?: CompetitionStatus };
    const data = await competitionService.list(guildId, { season, status });
    return res
      .status(200)
      .json({ status: 'success', message: 'Competitions retrieved successfully', data });
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/competitions/:guildId/resolve?name= */
export const resolveCompetition = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionResolveResult>>,
  next: NextFunction,
) => {
  try {
    const { guildId } = req.params as { guildId: string };
    const { name } = req.query as { name?: string };
    const data = await competitionService.resolveByName(guildId, name);
    return res
      .status(200)
      .json({ status: 'success', message: 'Competition resolved', data });
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/competitions/:guildId/:competitionId */
export const getCompetitionDetail = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionDetail>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const data = await competitionService.getDetail(guildId, Number(competitionId));
    if (!data) {
      return res.status(404).json({ status: 'error', message: 'Competition not found', data: null });
    }
    return res
      .status(200)
      .json({ status: 'success', message: 'Competition detail retrieved successfully', data });
  } catch (error) {
    return next(error);
  }
};

/** @route PATCH /api/competitions/:guildId/:competitionId/close */
export const closeCompetition = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<Competition>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const closed = await competitionService.close(guildId, Number(competitionId), resolveActor(req));
    return res
      .status(200)
      .json({ status: 'success', message: 'Competition closed successfully', data: closed });
  } catch (error) {
    return next(error);
  }
};

/** @route DELETE /api/competitions/:guildId/:competitionId */
export const deleteCompetition = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<Competition>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const removed = await competitionService.remove(guildId, Number(competitionId), resolveActor(req));
    return res
      .status(200)
      .json({ status: 'success', message: 'Competition deleted successfully', data: removed });
  } catch (error) {
    return next(error);
  }
};

/** @route POST /api/competitions/:guildId/:competitionId/applications */
export const createApplication = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionApplication>>,
  next: NextFunction,
) => {
  try {
    // 신청자는 로그인한 본인이어야 한다 — 봇에는 신청자를 특정할 세션이 없다.
    if (req.isBot) {
      return res.status(403).json({ status: 'error', message: 'Bot cannot apply', data: null });
    }
    if (!req.discordMemberId) {
      throw new BusinessError('Unauthorized', 401, { isLoggable: true });
    }
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const created = await competitionTeamService.apply(
      guildId,
      Number(competitionId),
      req.body as CompetitionApplyInput,
      req.discordMemberId,
    );
    return res
      .status(201)
      .json({ status: 'success', message: 'Application created successfully', data: created });
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/competitions/:guildId/:competitionId/applications?status= */
export const listApplications = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionApplicationItem[]>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const { status } = req.query as { status?: CompetitionApplicationStatus };
    const data = await competitionTeamService.listApplications(
      guildId,
      Number(competitionId),
      status,
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Applications retrieved successfully', data });
  } catch (error) {
    return next(error);
  }
};

/** 승인/거절 공통 — 경로 끝이 결정 상태다. */
const decideApplication =
  (status: 'APPROVED' | 'REJECTED') =>
  async (
    req: AuthRequest,
    res: Response<CompetitionResponse<CompetitionApplication>>,
    next: NextFunction,
  ) => {
    try {
      const { guildId, competitionId, applicationId } = req.params as {
        guildId: string;
        competitionId: string;
        applicationId: string;
      };
      const decided = await competitionTeamService.decideApplication(
        guildId,
        Number(competitionId),
        Number(applicationId),
        status,
        resolveActor(req),
      );
      return res
        .status(200)
        .json({ status: 'success', message: 'Application decided successfully', data: decided });
    } catch (error) {
      return next(error);
    }
  };

/** @route PATCH /api/competitions/:guildId/:competitionId/applications/:applicationId/approve */
export const approveApplication = decideApplication('APPROVED');

/** @route PATCH /api/competitions/:guildId/:competitionId/applications/:applicationId/reject */
export const rejectApplication = decideApplication('REJECTED');

/** @route POST /api/competitions/:guildId/:competitionId/teams */
export const createTeam = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionTeam>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const { name } = req.body as { name: string };
    const created = await competitionTeamService.createTeam(guildId, Number(competitionId), name);
    return res
      .status(201)
      .json({ status: 'success', message: 'Team created successfully', data: created });
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/competitions/:guildId/:competitionId/teams */
export const listTeams = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionTeamWithRoster[]>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const data = await competitionTeamService.listTeams(guildId, Number(competitionId));
    return res
      .status(200)
      .json({ status: 'success', message: 'Teams retrieved successfully', data });
  } catch (error) {
    return next(error);
  }
};

/** @route PATCH /api/competitions/:guildId/:competitionId/teams/:teamId */
export const updateTeam = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionTeam>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId, teamId } = req.params as {
      guildId: string;
      competitionId: string;
      teamId: string;
    };
    const updated = await competitionTeamService.updateTeam(
      guildId,
      Number(competitionId),
      Number(teamId),
      req.body as CompetitionTeamUpdateInput,
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Team updated successfully', data: updated });
  } catch (error) {
    return next(error);
  }
};

/** @route DELETE /api/competitions/:guildId/:competitionId/teams/:teamId */
export const deleteTeam = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionTeam>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId, teamId } = req.params as {
      guildId: string;
      competitionId: string;
      teamId: string;
    };
    const removed = await competitionTeamService.removeTeam(
      guildId,
      Number(competitionId),
      Number(teamId),
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Team deleted successfully', data: removed });
  } catch (error) {
    return next(error);
  }
};

/** @route POST /api/competitions/:guildId/:competitionId/teams/:teamId/members */
export const addTeamMember = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionTeamMember>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId, teamId } = req.params as {
      guildId: string;
      competitionId: string;
      teamId: string;
    };
    const { playerCode } = req.body as { playerCode: string };
    const created = await competitionTeamService.addMember(
      guildId,
      Number(competitionId),
      Number(teamId),
      playerCode,
    );
    return res
      .status(201)
      .json({ status: 'success', message: 'Roster member added successfully', data: created });
  } catch (error) {
    return next(error);
  }
};

/** @route DELETE /api/competitions/:guildId/:competitionId/teams/:teamId/members/:playerCode */
export const removeTeamMember = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionTeamMember>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId, teamId, playerCode } = req.params as {
      guildId: string;
      competitionId: string;
      teamId: string;
      playerCode: string;
    };
    const removed = await competitionTeamService.removeMember(
      guildId,
      Number(competitionId),
      Number(teamId),
      playerCode,
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Roster member removed successfully', data: removed });
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/competitions/:guildId/:competitionId/matches?unassigned=true */
export const listCompetitionMatches = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionMatchTeamItem[]>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const { unassigned } = req.query as { unassigned?: string };
    const data = await competitionTeamService.listMatches(
      guildId,
      Number(competitionId),
      unassigned === 'true',
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Matches retrieved successfully', data });
  } catch (error) {
    return next(error);
  }
};

/** @route PUT /api/competitions/:guildId/:competitionId/matches/:customMatchId/teams */
export const assignMatchTeams = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionMatchTeam[]>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId, customMatchId } = req.params as {
      guildId: string;
      competitionId: string;
      customMatchId: string;
    };
    const { blue, red } = req.body as { blue: number | null; red: number | null };
    const data = await competitionTeamService.assignMatchTeams(
      guildId,
      Number(competitionId),
      customMatchId,
      { blue, red },
      resolveActor(req),
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Match teams assigned successfully', data });
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/competitions/:guildId/:competitionId/teams/:teamId/records */
export const getTeamRecords = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionTeamRecordItem[]>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId, teamId } = req.params as {
      guildId: string;
      competitionId: string;
      teamId: string;
    };
    const data = await competitionTeamService.getTeamRecords(
      guildId,
      Number(competitionId),
      Number(teamId),
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Team records retrieved successfully', data });
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/competitions/:guildId/:competitionId/records?teamA=&teamB= */
export const getTeamHeadToHead = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionHeadToHeadResult>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const { teamA, teamB } = req.query as { teamA: string; teamB: string };
    const data = await competitionTeamService.getHeadToHead(
      guildId,
      Number(competitionId),
      Number(teamA),
      Number(teamB),
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Head to head record retrieved successfully', data });
  } catch (error) {
    return next(error);
  }
};
