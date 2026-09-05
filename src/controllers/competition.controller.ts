import { NextFunction, Response } from 'express';
import { AuthRequest } from '../middlewares/authHandler.js';
import { BusinessError } from '../types/error.js';
import { competitionService } from '../services/competition.service.js';
import {
  competitionTeamService,
  visibleApplicationStatus,
} from '../services/competitionTeam.service.js';
import { competitionPlayerService } from '../services/competitionPlayer.service.js';
import { hasGuildRole } from '../middlewares/requireRole.js';
import {
  CompetitionActor,
  CompetitionApplicationItem,
  CompetitionApplicationStatus,
  CompetitionApplicationUpdateInput,
  CompetitionApplyInput,
  CompetitionGameType,
  CompetitionPosition,
  RosterSaveInput,
  CompetitionCreateInput,
  CompetitionDetail,
  CompetitionHeadToHeadResult,
  CompetitionMatchTeamItem,
  CompetitionResolveResult,
  CompetitionResponse,
  CompetitionStandings,
  CompetitionStatus,
  CompetitionSummary,
  MatchGameTypeChangeResult,
  PlayerCompetitionItem,
  CompetitionTeamRecordItem,
  CompetitionTeamRoster,
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

/** 신청 API는 로그인한 본인 것만 다룬다 — 봇에는 신청자를 특정할 세션이 없다. */
const botCannotApply = <T>(res: Response<CompetitionResponse<T>>) =>
  res.status(403).json({ status: 'error', message: 'Bot cannot apply', data: null });

const applicantMemberId = (req: AuthRequest): string => {
  if (!req.discordMemberId) {
    throw new BusinessError('Unauthorized', 401, { isLoggable: true });
  }
  return req.discordMemberId;
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
    if (req.isBot) return botCannotApply(res);
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const created = await competitionTeamService.apply(
      guildId,
      Number(competitionId),
      req.body as CompetitionApplyInput,
      applicantMemberId(req),
    );
    return res
      .status(201)
      .json({ status: 'success', message: 'Application created successfully', data: created });
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/competitions/:guildId/:competitionId/applications/me */
export const getMyApplication = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionApplicationItem>>,
  next: NextFunction,
) => {
  try {
    if (req.isBot) return botCannotApply(res);
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const data = await competitionTeamService.getMyApplication(
      guildId,
      Number(competitionId),
      applicantMemberId(req),
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Application retrieved successfully', data });
  } catch (error) {
    return next(error);
  }
};

/** @route PATCH /api/competitions/:guildId/:competitionId/applications/me */
export const updateMyApplication = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionApplication>>,
  next: NextFunction,
) => {
  try {
    if (req.isBot) return botCannotApply(res);
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const updated = await competitionTeamService.updateMyApplication(
      guildId,
      Number(competitionId),
      applicantMemberId(req),
      req.body as CompetitionApplicationUpdateInput,
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Application updated successfully', data: updated });
  } catch (error) {
    return next(error);
  }
};

/** @route DELETE /api/competitions/:guildId/:competitionId/applications/me */
export const deleteMyApplication = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionApplication>>,
  next: NextFunction,
) => {
  try {
    if (req.isBot) return botCannotApply(res);
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const removed = await competitionTeamService.deleteMyApplication(
      guildId,
      Number(competitionId),
      applicantMemberId(req),
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Application deleted successfully', data: removed });
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
    const canSeeAll = await hasGuildRole(req, 'guildManager', guildId);
    const data = await competitionTeamService.listApplications(
      guildId,
      Number(competitionId),
      visibleApplicationStatus(status, canSeeAll),
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Applications retrieved successfully', data });
  } catch (error) {
    return next(error);
  }
};

/** @route PATCH /api/competitions/:guildId/:competitionId/applications/decide */
export const decideApplications = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionApplication[]>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const { applicationIds, status } = req.body as {
      applicationIds: number[];
      status: CompetitionApplicationStatus;
    };
    const data = await competitionTeamService.decideApplications(
      guildId,
      Number(competitionId),
      applicationIds,
      status,
      resolveActor(req),
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Applications decided successfully', data });
  } catch (error) {
    return next(error);
  }
};

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
    const created = await competitionTeamService.addMember(
      guildId,
      Number(competitionId),
      Number(teamId),
      req.body as { playerCode: string; position: CompetitionPosition },
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

/** @route PUT /api/competitions/:guildId/:competitionId/roster */
export const saveRoster = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionTeamRoster[]>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const data = await competitionTeamService.saveRoster(
      guildId,
      Number(competitionId),
      req.body as RosterSaveInput,
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Roster saved successfully', data });
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

/** @route PATCH /api/competitions/:guildId/:competitionId/matches/game-type */
export const changeMatchGameType = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<MatchGameTypeChangeResult>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const { customMatchIds, gameType } = req.body as {
      customMatchIds: string[];
      gameType: CompetitionGameType;
    };
    const data = await competitionTeamService.changeMatchGameType(
      guildId,
      Number(competitionId),
      customMatchIds,
      gameType,
      resolveActor(req),
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Match game type changed successfully', data });
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

/** @route GET /api/competitions/:guildId/:competitionId/standings */
export const getStandings = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionStandings>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const data = await competitionTeamService.getStandings(guildId, Number(competitionId));
    return res
      .status(200)
      .json({ status: 'success', message: 'Standings retrieved successfully', data });
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/competitions/:guildId/players/:playerCode/competitions */
export const listPlayerCompetitions = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<PlayerCompetitionItem[]>>,
  next: NextFunction,
) => {
  try {
    const { guildId, playerCode } = req.params as { guildId: string; playerCode: string };
    const { status } = req.query as { status?: CompetitionStatus };
    const data = await competitionPlayerService.listCompetitions(guildId, playerCode, status);
    return res
      .status(200)
      .json({ status: 'success', message: 'Player competitions retrieved successfully', data });
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
