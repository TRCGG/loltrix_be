import { Request, Response, NextFunction } from 'express';
import * as XLSX from 'xlsx';
import { teamService } from '../services/team.service.js';
import {
  CreateTeamRequest,
  UpdateTeamRequest,
  AddTeamMemberRequest,
  TeamResponse,
  TeamMemberHistoryResponse,
  ExcelUploadResponse,
  GetTeamsQuery,
} from '../types/team.js';

/**
 * @route POST /api/teams/:guildId
 * @desc 팀 생성
 */
export const createTeam = async (
  req: Request<{ guildId: string }, TeamResponse, CreateTeamRequest>,
  res: Response<TeamResponse>,
  next: NextFunction,
) => {
  try {
    const { guildId } = req.params;
    const { name } = req.body;

    const newTeam = await teamService.createTeam(guildId, name);

    return res.status(201).json({
      status: 'success',
      message: 'Team created successfully',
      data: newTeam,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @route GET /api/teams/:guildId
 * @desc 길드별 팀 목록 조회
 */
export const getTeamsByGuild = async (
  req: Request<{ guildId: string }, TeamResponse, Record<string, never>, GetTeamsQuery>,
  res: Response<TeamResponse>,
  next: NextFunction,
) => {
  try {
    const { guildId } = req.params;
    const { page, limit, search } = req.query;

    const { result, totalCount } = await teamService.findTeamsByGuild(
      { page, limit, search },
      guildId,
    );

    res.setHeader('X-Total-Count', totalCount.toString());
    res.setHeader('X-Page', (page ?? 1).toString());
    res.setHeader('X-Limit', (limit ?? 10).toString());
    res.setHeader('X-Total-Pages', Math.ceil(totalCount / (Number(limit) || 10)).toString());

    return res.status(200).json({
      status: 'success',
      message: 'Teams retrieved successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @route GET /api/teams/:guildId/:teamCode
 * @desc 팀 상세 조회
 */
export const getTeamByCode = async (
  req: Request<{ guildId: string; teamCode: string }>,
  res: Response<TeamResponse>,
  next: NextFunction,
) => {
  try {
    const { guildId, teamCode } = req.params;

    const teamResult = await teamService.findTeamByCode(teamCode, guildId);

    if (!teamResult) {
      return res.status(404).json({
        status: 'error',
        message: 'Team not found',
        data: null,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Team retrieved successfully',
      data: teamResult,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @route PUT /api/teams/:guildId/:teamCode
 * @desc 팀 이름 수정
 */
export const updateTeam = async (
  req: Request<{ guildId: string; teamCode: string }, TeamResponse, UpdateTeamRequest>,
  res: Response<TeamResponse>,
  next: NextFunction,
) => {
  try {
    const { guildId, teamCode } = req.params;
    const { name } = req.body;

    const updatedTeam = await teamService.updateTeam(teamCode, guildId, name);

    if (!updatedTeam) {
      return res.status(404).json({
        status: 'error',
        message: 'Team not found',
        data: null,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Team updated successfully',
      data: updatedTeam,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @route DELETE /api/teams/:guildId/:teamCode
 * @desc 팀 삭제 (소프트 삭제)
 */
export const deleteTeam = async (
  req: Request<{ guildId: string; teamCode: string }>,
  res: Response<TeamResponse>,
  next: NextFunction,
) => {
  try {
    const { guildId, teamCode } = req.params;

    const deletedTeam = await teamService.softDeleteTeam(teamCode, guildId);

    if (!deletedTeam) {
      return res.status(404).json({
        status: 'error',
        message: 'Team not found',
        data: null,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Team deleted successfully',
      data: deletedTeam,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @route POST /api/teams/:guildId/:teamCode/members
 * @desc 팀원 추가
 */
export const addTeamMember = async (
  req: Request<{ guildId: string; teamCode: string }, TeamResponse, AddTeamMemberRequest>,
  res: Response<TeamResponse>,
  next: NextFunction,
) => {
  try {
    const { guildId, teamCode } = req.params;
    const { riotName, riotNameTag, position } = req.body;

    const result = await teamService.addTeamMember(
      teamCode,
      guildId,
      riotName,
      riotNameTag,
      position,
    );

    return res.status(201).json({
      status: 'success',
      message: 'Team member added successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @route DELETE /api/teams/:guildId/:teamCode/members/:playerCode
 * @desc 팀원 제거
 */
export const removeTeamMember = async (
  req: Request<{ guildId: string; teamCode: string; playerCode: string }>,
  res: Response<TeamResponse>,
  next: NextFunction,
) => {
  try {
    const { guildId, teamCode, playerCode } = req.params;

    const result = await teamService.removeTeamMember(teamCode, guildId, playerCode);

    return res.status(200).json({
      status: 'success',
      message: 'Team member removed successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @route GET /api/teams/:guildId/:teamCode/members/history
 * @desc 팀원 변경 이력 조회
 */
export const getTeamMemberHistory = async (
  req: Request<{ guildId: string; teamCode: string }>,
  res: Response<TeamMemberHistoryResponse>,
  next: NextFunction,
) => {
  try {
    const { guildId, teamCode } = req.params;

    const history = await teamService.getTeamMemberHistory(teamCode, guildId);

    return res.status(200).json({
      status: 'success',
      message: 'Team member history retrieved successfully',
      data: history,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @route POST /api/teams/:guildId/excel
 * @desc 엑셀 파일로 팀 일괄 생성
 */
export const createTeamsFromExcel = async (
  req: Request<{ guildId: string }>,
  res: Response<ExcelUploadResponse>,
  next: NextFunction,
) => {
  try {
    const { guildId } = req.params;
    const { file } = req;

    if (!file) {
      return res.status(400).json({
        status: 'error',
        message: 'No file uploaded',
        data: null,
      });
    }

    // 엑셀 파싱
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet);

    if (rawRows.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Excel file is empty',
        data: null,
      });
    }

    // 엑셀 행을 파싱하여 팀 데이터로 변환
    const rows = rawRows.map((row) => {
      const values = Object.values(row);
      const teamName = values[0] || '';
      const members = values
        .slice(1)
        .filter(Boolean)
        .map((v) => {
          const parts = String(v).split('#');
          return {
            riotName: parts[0]?.trim() || '',
            riotNameTag: parts.slice(1).join('#')?.trim() || '',
          };
        });
      return { teamName: String(teamName).trim(), members };
    });

    const result = await teamService.createTeamsFromExcel(guildId, rows);

    return res.status(201).json({
      status: 'success',
      message: 'Excel upload completed',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};
