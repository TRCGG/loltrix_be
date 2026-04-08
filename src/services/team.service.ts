import { eq, and, desc, sql, ilike } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { team, teamMember, riotAccount } from '../database/schema.js';
import { BusinessError, SystemError } from '../types/error.js';
import {
  TeamWithMembers,
  TeamMemberWithAccount,
  TeamListItem,
  GetTeamsQuery,
  ExcelUploadResult,
} from '../types/team.js';

export class TeamService {
  /**
   * @desc 팀 생성
   */
  public async createTeam(guildId: string, name: string) {
    try {
      const [result] = await db.insert(team).values({ name, guildId }).returning();
      return result;
    } catch (error) {
      console.error('Error creating team:', error);
      throw new SystemError('Team error while creating', 500);
    }
  }

  /**
   * @desc 길드별 팀 목록 조회 (페이지네이션 + 검색 + 현재 멤버 수)
   */
  public async findTeamsByGuild({ page = 1, limit = 10, search }: GetTeamsQuery, guildId: string) {
    const offset = (Number(page) - 1) * Number(limit);
    const baseCondition = and(eq(team.guildId, guildId), eq(team.isDeleted, false));
    const whereCondition = search
      ? and(baseCondition, ilike(team.name, `%${search}%`))
      : baseCondition;

    const result = await db
      .select({
        id: team.id,
        teamCode: team.teamCode,
        name: team.name,
        guildId: team.guildId,
        createDate: team.createDate,
        updateDate: team.updateDate,
        isDeleted: team.isDeleted,
        memberCount: sql<number>`count(${teamMember.id}) filter (where ${teamMember.isActive} = true and ${teamMember.isDeleted} = false)`,
      })
      .from(team)
      .leftJoin(teamMember, eq(team.id, teamMember.teamId))
      .where(whereCondition)
      .groupBy(team.id)
      .orderBy(desc(team.createDate))
      .limit(Number(limit))
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(team)
      .where(whereCondition);

    const totalCount = countResult[0]?.count || 0;

    return { result: result as TeamListItem[], totalCount };
  }

  /**
   * @desc teamCode로 팀 상세 조회 (활성 멤버 포함)
   */
  public async findTeamByCode(teamCode: string, guildId: string): Promise<TeamWithMembers | null> {
    const [teamResult] = await db
      .select()
      .from(team)
      .where(and(eq(team.teamCode, teamCode), eq(team.guildId, guildId), eq(team.isDeleted, false)))
      .limit(1);

    if (!teamResult) return null;

    const members = await db
      .select({
        id: teamMember.id,
        teamId: teamMember.teamId,
        playerCode: teamMember.playerCode,
        position: teamMember.position,
        isActive: teamMember.isActive,
        joinDate: teamMember.joinDate,
        leaveDate: teamMember.leaveDate,
        createDate: teamMember.createDate,
        updateDate: teamMember.updateDate,
        isDeleted: teamMember.isDeleted,
        riotName: riotAccount.riotName,
        riotNameTag: riotAccount.riotNameTag,
      })
      .from(teamMember)
      .innerJoin(riotAccount, eq(teamMember.playerCode, riotAccount.playerCode))
      .where(
        and(
          eq(teamMember.teamId, teamResult.id),
          eq(teamMember.isActive, true),
          eq(teamMember.isDeleted, false),
        ),
      );

    return {
      ...teamResult,
      members: members as TeamMemberWithAccount[],
    };
  }

  /**
   * @desc 팀 이름 수정
   */
  public async updateTeam(teamCode: string, guildId: string, name: string) {
    const [result] = await db
      .update(team)
      .set({ name })
      .where(and(eq(team.teamCode, teamCode), eq(team.guildId, guildId), eq(team.isDeleted, false)))
      .returning();
    return result;
  }

  /**
   * @desc 팀 소프트 삭제
   */
  public async softDeleteTeam(teamCode: string, guildId: string) {
    const [teamResult] = await db
      .select()
      .from(team)
      .where(and(eq(team.teamCode, teamCode), eq(team.guildId, guildId), eq(team.isDeleted, false)))
      .limit(1);

    if (!teamResult) return null;

    await db.transaction(async (tx) => {
      // 팀 삭제
      await tx.update(team).set({ isDeleted: true }).where(eq(team.id, teamResult.id));

      // 팀 멤버도 삭제
      await tx
        .update(teamMember)
        .set({ isDeleted: true, isActive: false, leaveDate: new Date() })
        .where(and(eq(teamMember.teamId, teamResult.id), eq(teamMember.isDeleted, false)));
    });

    return teamResult;
  }

    /**
   * @desc 팀원 추가 (라이엇 닉네임#태그로 검색)
   */
  public async addTeamMember(
    teamCode: string,
    guildId: string,
    riotName: string,
    riotNameTag: string,
    position?: string,
  ) {
    // 1. 팀 조회
    const [teamResult] = await db
      .select()
      .from(team)
      .where(and(eq(team.teamCode, teamCode), eq(team.guildId, guildId), eq(team.isDeleted, false)))
      .limit(1);

    if (!teamResult) {
      throw new BusinessError('팀을 찾을 수 없습니다.', 404);
    }

    // 2. 라이엇 계정 조회
    const [account] = await db
      .select()
      .from(riotAccount)
      .where(
        and(
          eq(riotAccount.riotName, riotName),
          eq(riotAccount.riotNameTag, riotNameTag),
          eq(riotAccount.isDeleted, false),
        ),
      )
      .limit(1);

    if (!account) {
      throw new BusinessError(`라이엇 계정을 찾을 수 없습니다: ${riotName}#${riotNameTag}`, 404);
    }

    // 3. 이미 활성 멤버인지 확인
    const [existing] = await db
      .select()
      .from(teamMember)
      .where(
        and(
          eq(teamMember.teamId, teamResult.id),
          eq(teamMember.playerCode, account.playerCode),
          eq(teamMember.isActive, true),
          eq(teamMember.isDeleted, false),
        ),
      )
      .limit(1);

    if (existing) {
      throw new BusinessError('이미 팀에 등록된 멤버입니다.', 409);
    }

    // 4. 팀원 추가
    const [result] = await db
      .insert(teamMember)
      .values({
        teamId: teamResult.id,
        playerCode: account.playerCode,
        position: position || null,
      })
      .returning();

    return {
      ...result,
      riotName: account.riotName,
      riotNameTag: account.riotNameTag,
    };
  }

  /**
   * @desc 팀원 제거 (isActive=false, leaveDate 설정)
   */
  public async removeTeamMember(teamCode: string, guildId: string, playerCode: string) {
    // 1. 팀 조회
    const [teamResult] = await db
      .select()
      .from(team)
      .where(and(eq(team.teamCode, teamCode), eq(team.guildId, guildId), eq(team.isDeleted, false)))
      .limit(1);

    if (!teamResult) {
      throw new BusinessError('팀을 찾을 수 없습니다.', 404);
    }

    // 2. 활성 멤버 확인 및 비활성화
    const [result] = await db
      .update(teamMember)
      .set({ isActive: false, leaveDate: new Date() })
      .where(
        and(
          eq(teamMember.teamId, teamResult.id),
          eq(teamMember.playerCode, playerCode),
          eq(teamMember.isActive, true),
          eq(teamMember.isDeleted, false),
        ),
      )
      .returning();

    if (!result) {
      throw new BusinessError('해당 팀원을 찾을 수 없습니다.', 404);
    }

    return result;
  }

  /**
   * @desc 팀원 변경 이력 조회 (활성 + 비활성 모두)
   */
  public async getTeamMemberHistory(teamCode: string, guildId: string) {
    const [teamResult] = await db
      .select()
      .from(team)
      .where(and(eq(team.teamCode, teamCode), eq(team.guildId, guildId), eq(team.isDeleted, false)))
      .limit(1);

    if (!teamResult) {
      throw new BusinessError('팀을 찾을 수 없습니다.', 404);
    }

    const members = await db
      .select({
        id: teamMember.id,
        teamId: teamMember.teamId,
        playerCode: teamMember.playerCode,
        position: teamMember.position,
        isActive: teamMember.isActive,
        joinDate: teamMember.joinDate,
        leaveDate: teamMember.leaveDate,
        createDate: teamMember.createDate,
        updateDate: teamMember.updateDate,
        isDeleted: teamMember.isDeleted,
        riotName: riotAccount.riotName,
        riotNameTag: riotAccount.riotNameTag,
      })
      .from(teamMember)
      .innerJoin(riotAccount, eq(teamMember.playerCode, riotAccount.playerCode))
      .where(and(eq(teamMember.teamId, teamResult.id), eq(teamMember.isDeleted, false)))
      .orderBy(desc(teamMember.joinDate));

    return members as TeamMemberWithAccount[];
  }

  /**
   * @desc 엑셀 데이터로 팀 일괄 생성
   */
  public async createTeamsFromExcel(
    guildId: string,
    rows: Array<{ teamName: string; members: Array<{ riotName: string; riotNameTag: string }> }>,
  ): Promise<ExcelUploadResult> {
    const succeeded: ExcelUploadResult['succeeded'] = [];
    const failed: ExcelUploadResult['failed'] = [];

    for (const row of rows) {
      const { teamName, members } = row;

      if (!teamName || teamName.trim().length === 0) {
        failed.push({ teamName: teamName || '(비어있음)', reason: 'empty_team_name' });
        continue;
      }

      const notFoundMembers: string[] = [];
      const foundAccounts: Array<{ playerCode: string; riotName: string; riotNameTag: string }> =
        [];

      // 멤버별 라이엇 계정 조회
      for (const member of members) {
        if (!member.riotName || member.riotName.trim().length === 0) continue;

        const [account] = await db
          .select()
          .from(riotAccount)
          .where(
            and(
              eq(riotAccount.riotName, member.riotName),
              eq(riotAccount.riotNameTag, member.riotNameTag),
              eq(riotAccount.isDeleted, false),
            ),
          )
          .limit(1);

        if (account) {
          foundAccounts.push({
            playerCode: account.playerCode,
            riotName: account.riotName,
            riotNameTag: account.riotNameTag,
          });
        } else {
          notFoundMembers.push(`${member.riotName}#${member.riotNameTag}`);
        }
      }

      if (notFoundMembers.length > 0) {
        failed.push({
          teamName,
          reason: 'members_not_found',
          details: notFoundMembers,
        });
        continue;
      }

      if (foundAccounts.length === 0) {
        failed.push({ teamName, reason: 'no_valid_members' });
        continue;
      }

      try {
        await db.transaction(async (tx) => {
          // 팀 생성
          const [newTeam] = await tx
            .insert(team)
            .values({ name: teamName.trim(), guildId })
            .returning();

          // 팀원 등록
          await tx.insert(teamMember).values(
            foundAccounts.map((acc) => ({
              teamId: newTeam.id,
              playerCode: acc.playerCode,
            })),
          );

          succeeded.push({
            teamName: newTeam.name,
            teamCode: newTeam.teamCode,
            memberCount: foundAccounts.length,
          });
        });
      } catch (error) {
        console.error(`Error creating team ${teamName}:`, error);
        failed.push({ teamName, reason: 'create_failed' });
      }
    }

    return { succeeded, failed };
  }
}

export const teamService = new TeamService();
