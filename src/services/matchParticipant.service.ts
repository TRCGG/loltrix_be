import { z } from 'zod';
import { eq, ne, and, desc, sql, inArray } from 'drizzle-orm';
import { db, TransactionType } from '../database/connectionPool.js';
import { alias } from 'drizzle-orm/pg-core';
import { 
  InsertMatchParticipant, 
  matchParticipant, 
  champion, 
  riotAccount, 
  customMatch, 
  summonerSpell,
  perks,
} from '../database/schema.js'; // 스키마 import 추가
import { BusinessError, SystemError } from '../types/error.js';

const MatchparticipantSchema = z.object({
  PUUID: z.string().max(64),
  SKIN: z.string().max(16),
  TEAM: z.string().max(8),
  WIN: z.string().max(8),
  TEAM_POSITION: z.string().max(16),
  CHAMPIONS_KILLED: z.string(),
  NUM_DEATHS: z.string(),
  ASSISTS: z.string(),
  GOLD_EARNED: z.string(),
  TIME_CCING_OTHERS: z.string(),
  EXP: z.string(),
  TIME_PLAYED: z.string(),
  TOTAL_DAMAGE_DEALT_TO_CHAMPIONS: z.string(),
  TOTAL_DAMAGE_DEALT_TO_BUILDINGS: z.string(),
  TOTAL_DAMAGE_TAKEN: z.string(),
  VISION_SCORE: z.string(),
  VISION_WARDS_BOUGHT_IN_GAME: z.string(),
  PENTA_KILLS: z.string().optional(),
  LEVEL: z.string(),
  ITEM0: z.string(),
  ITEM1: z.string(),
  ITEM2: z.string(),
  ITEM3: z.string(),
  ITEM4: z.string(),
  ITEM5: z.string(),
  ITEM6: z.string(),
  SUMMONER_SPELL_1: z.string().optional(),
  SUMMONER_SPELL_2: z.string().optional(),
  PERK0: z.string().optional(),
  PERK1: z.string().optional(),
  PERK2: z.string().optional(),
  PERK3: z.string().optional(),
  PERK4: z.string().optional(),
  PERK5: z.string().optional(),
  KEYSTONE_ID: z.string(),
  PERK_SUB_STYLE: z.string(),
  MINIONS_KILLED: z.string().optional(),
  NEUTRAL_MINIONS_KILLED: z.string().optional(),
  NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE: z.string().optional(),
  NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE: z.string().optional(),
});

const MatchparticipantArraySchema = z.array(MatchparticipantSchema);

/**
 * @desc "blue" 또는 "red"로 변환
 */
const mapTeam = (teamId: string): string => {
  if (teamId === '100') return 'blue';
  if (teamId === '200') return 'red';
  return teamId;
};

/**
 * @desc 승리 여부 ("Win")를 "승" 또는 "패"로 변환
 */
const mapResult = (winStatus: string): string => {
  return winStatus === 'Win' ? '승' : '패';
};

/**
 * @desc 포지션 변환
 */
const mapPosition = (position: string): string => {
  switch (position) {
    case 'JUNGLE':
      return 'JUG';
    case 'BOTTOM':
      return 'ADC';
    case 'UTILITY':
      return 'SUP';
    case 'MIDDLE':
      return 'MID';
    case 'TOP':
      return 'TOP';
    default:
      return position;
  }
};

/**
 * @desc 내전 참여자 서비스 
 */
export class MatchParticipantService {
  constructor() {}

  /**
   * 여러 참가자 데이터를 DB에 삽입합니다.
   * @param rawData - API로부터 받은 원본 데이터 배열
   * @param customMatchId - 이 참가자들이 속한 custom_match의 ID
   * @param tx - Drizzle 트랜잭션 객체
   */
  public async insertMatchParticipants(
    rawData: any[], 
    customMatchId: string, 
    tx: TransactionType,
    puuidToPlayerCodeMap: Map<string, string>
  ) {
    try {
      // 1. rawData를 파싱하고 챔피언 ID로 변환
      const newData = await this.parsedMatchParticipant(rawData, customMatchId, puuidToPlayerCodeMap);

      // 2. 변환된 데이터를 삽입
      const result = await tx.insert(matchParticipant).values(newData).returning();
      return result;
    } catch (error) {
      console.error('Error inserting MatchParticipants', error);
      throw new SystemError('Matchparticipants error while inserting', 500);
    }
  }

  /**
   * @desc rawData 배열을 Drizzle 삽입용 InsertMatchParticipant 배열로 파싱하고 변환
   * @param rawData 
   * @param customMatchId - 이 참가자들이 속한 custom_match의 ID
   * @returns InsertMatchParticipant 타입의 객체 배열 Promise
   */
  private async parsedMatchParticipant(
    rawData: any,
    customMatchId: string,
    puuidToPlayerCodeMap: Map<string, string>
  ): Promise<InsertMatchParticipant[]> {
    // Zod를 사용하여 원본 데이터 검증
    const validatedData = MatchparticipantArraySchema.parse(rawData);

    // 1. 필요한 모든 챔피언 영문 이름(d.SKIN)을 중복 없이 추출합니다.
    const championEngNames = [...new Set(validatedData.map((d) => d.SKIN).filter(Boolean))];

    // 2. 챔피언 영문, ID DB조회
    const championRecords = await db
      .select({ id: champion.id, nameEng: champion.champNameEng })
      .from(champion)
      .where(inArray(champion.champNameEng, championEngNames));

    // 3. 챔피언 영문 이름을 Key, 챔피언 ID를 Value로 하는 Map
    const championNameIdMap = new Map<string, string>();
    for (const record of championRecords) {
      if (record.nameEng) {
        championNameIdMap.set(record.nameEng, record.id);
      }
    }

    const parseIntOptional = (val: string | undefined): number | undefined => {
      if (val === undefined || val === null) return undefined;
      const num = parseInt(val, 10);
      return isNaN(num) ? undefined : num;
    };

    const parsedMatchParticipants: InsertMatchParticipant[] = validatedData.map((d) => {
      const championId = championNameIdMap.get(d.SKIN) || d.SKIN;

      const gameTeam = mapTeam(d.TEAM);
      const gameResult = mapResult(d.WIN);
      const position = mapPosition(d.TEAM_POSITION);

      const participantPuuid = d.PUUID;
      const participantPlayerCode = puuidToPlayerCodeMap.get(participantPuuid) || 'error_player_code';

      return {
        customMatchId: customMatchId,
        playerCode: participantPlayerCode,
        championId: championId,
        gameTeam: gameTeam,
        gameResult: gameResult,
        position: position,
        kill: parseInt(d.CHAMPIONS_KILLED),
        death: parseInt(d.NUM_DEATHS),
        assist: parseInt(d.ASSISTS),
        gold: parseInt(d.GOLD_EARNED),
        ccing: parseInt(d.TIME_CCING_OTHERS),
        exp: parseInt(d.EXP),
        timePlayed: parseInt(d.TIME_PLAYED) ,
        totalDamageChampions: parseInt(d.TOTAL_DAMAGE_DEALT_TO_CHAMPIONS), 
        totalDamageDealtToBuildings: parseInt(d.TOTAL_DAMAGE_DEALT_TO_BUILDINGS),
        totalDamageTaken: parseInt(d.TOTAL_DAMAGE_TAKEN),
        visionScore: parseInt(d.VISION_SCORE),
        visionBought: parseInt(d.VISION_WARDS_BOUGHT_IN_GAME),
        pentaKills: parseIntOptional(d.PENTA_KILLS),
        level: parseInt(d.LEVEL),
        item0: parseInt(d.ITEM0),
        item1: parseInt(d.ITEM1),
        item2: parseInt(d.ITEM2),
        item3: parseInt(d.ITEM3),
        item4: parseInt(d.ITEM4),
        item5: parseInt(d.ITEM5),
        item6: parseInt(d.ITEM6),
        summonerSpell1: parseIntOptional(d.SUMMONER_SPELL_1),
        summonerSpell2: parseIntOptional(d.SUMMONER_SPELL_2),
        perk0: parseIntOptional(d.PERK0),
        perk1: parseIntOptional(d.PERK1),
        perk2: parseIntOptional(d.PERK2),
        perk3: parseIntOptional(d.PERK3),
        perk4: parseIntOptional(d.PERK4),
        perk5: parseIntOptional(d.PERK5),
        keyStoneId: parseInt(d.KEYSTONE_ID),
        perkSubStyle: parseInt(d.PERK_SUB_STYLE),
        minionsKilled: parseIntOptional(d.MINIONS_KILLED),
        neutralMinionsKilled: parseIntOptional(d.NEUTRAL_MINIONS_KILLED),
        neutralMinionsKilledYourJungle: parseIntOptional(d.NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE),
        neutralMinionsKilledEnemyJungle: parseIntOptional(d.NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE),
      };
    });

    return parsedMatchParticipants;
  }
  // [Read] 데이터 조회 관련 메서드
  /**
   * @desc 승률 및 KDA 계산용 SQL 조각 생성 (Helper)
   */
  private getStatSqlChunks(table: any = matchParticipant) {
    return {
      totalCount: sql<number>`COUNT(*)::integer`,
      win: sql<number>`COUNT(CASE WHEN ${table.gameResult} = '승' THEN 1 END)::integer`,
      lose: sql<number>`COUNT(CASE WHEN ${table.gameResult} = '패' THEN 1 END)::integer`,
      winRate: sql<number>`
        CASE 
          WHEN COUNT(*) = 0 THEN 0 
          ELSE ROUND(
            (COUNT(CASE WHEN ${table.gameResult} = '승' THEN 1 END)::numeric * 100.0) / NULLIF(COUNT(*), 0), 
            2
          ) 
        END`,
      kda: sql<number>`
        CASE 
          WHEN COALESCE(SUM(${table.death}), 0) = 0 THEN 9999 
          ELSE ROUND(
            (COALESCE(SUM(${table.kill}), 0) + COALESCE(SUM(${table.assist}), 0))::numeric 
            / NULLIF(COALESCE(SUM(${table.death}), 0), 0), 
            2
          ) 
        END`
    };
  }

  /**
   * @desc 최근 한 달 전적 요약 조회
   */
  public async getRecentMonthRecord(playerCode: string,) {
    // 통계 쿼리 실행
    const statColumns = this.getStatSqlChunks();

    const [result] = await db
      .select(statColumns)
      .from(matchParticipant)
      .innerJoin(customMatch, eq(matchParticipant.customMatchId, customMatch.id))
      .where(
        and(
          eq(matchParticipant.playerCode, playerCode),
          eq(matchParticipant.isDeleted, false),
          eq(customMatch.isDeleted, false),
          sql`TO_CHAR(${customMatch.createDate}, 'YYYY-MM') = TO_CHAR(NOW(), 'YYYY-MM')`,
        ),
      );

    return (
      result || {
        totalCount: 0,
        winCount: 0,
        loseCount: 0,
        winRate: 0,
        kda: 0,
      }
    );
  }

  /**
   * @desc 전체 라인별(포지션별) 전적 조회
   * 정렬 순서: TOP -> JUG -> MID -> ADC -> SUP
   */
  public async getLineRecord(playerCode: string, season: string) {
    // 포지션별 통계 집계
    const statColumns = this.getStatSqlChunks();

    const result = await db
      .select({
        position: matchParticipant.position,
        ...statColumns,
      })
      .from(matchParticipant)
      .innerJoin(customMatch, eq(matchParticipant.customMatchId, customMatch.id))
      .where(and(
        eq(matchParticipant.playerCode, playerCode),
        eq(matchParticipant.isDeleted, false),
        eq(customMatch.isDeleted, false),
        eq(customMatch.season, season)
      ))
      .groupBy(matchParticipant.position)
      .orderBy(sql`
        CASE ${matchParticipant.position}
          WHEN 'TOP' THEN 1
          WHEN 'JUG' THEN 2
          WHEN 'MID' THEN 3
          WHEN 'ADC' THEN 4
          WHEN 'SUP' THEN 5
          ELSE 6
        END
      `);

    return result;
  }

  /**
   * @desc 모스트 픽 조회 (챔피언별 통계)
   * 정렬: 플레이 횟수(totalCount) 많은 순 (DESC)
   * 페이지네이션 적용
   */
  public async getMostPicks(
    playerCode: string,
    season: string,
    page: number = 1,
    limit: number = 10
  ) {
    const offset = (page - 1) * limit;
    // 통계 쿼리 실행
    const statColumns = this.getStatSqlChunks();

    const result = await db
      .select({
        champName: champion.champName,       
        champNameEng: champion.champNameEng, 
        ...statColumns,                      
      })
      .from(matchParticipant)
      .innerJoin(champion, eq(matchParticipant.championId, champion.id))
      .innerJoin(customMatch, eq(matchParticipant.customMatchId, customMatch.id))
      .where(and(
        eq(matchParticipant.playerCode, playerCode),
        eq(matchParticipant.isDeleted, false),
        eq(customMatch.isDeleted, false),
        eq(customMatch.season, season)
      ))
      .groupBy(champion.champName, champion.champNameEng)
      .orderBy(desc(sql`count(*)`))
      .limit(limit)
      .offset(offset);

    return result;
  }

  /**
   * @desc 최근게임목록 상세 조회
   */
  public async getRecentGamesByRiotName(
    playerCode: string,
    season: string,
    page: number = 1,
    limit: number = 20
  ) {
    const offset = (page - 1) * limit;

    // Alias 정의 
    const sp1 = alias(summonerSpell, 'sp1');
    const sp2 = alias(summonerSpell, 'sp2');
    const keystone = alias(perks, 'keystone');
    const substyle = alias(perks, 'substyle');

    const whereCondition = and(
      eq(matchParticipant.playerCode, playerCode),
      eq(matchParticipant.isDeleted, false),
      eq(customMatch.isDeleted, false),
      eq(customMatch.season, season)
    );

    const gamesQuery = db
      .select({
        // Game Info
        gameId: customMatch.id,
        season: customMatch.season,
        createDate: customMatch.createDate,
        gameResult: matchParticipant.gameResult,
        gameTeam: matchParticipant.gameTeam,
        timePlayed: matchParticipant.timePlayed,

        // Player Info
        riotName: riotAccount.riotName,
        riotNameTag: riotAccount.riotNameTag,
        
        // Champion Info
        champName: champion.champName,
        champNameEng: champion.champNameEng,
        position: matchParticipant.position,
        level: matchParticipant.level,

        // KDA & Combat
        kill: matchParticipant.kill,
        death: matchParticipant.death,
        assist: matchParticipant.assist,
        pentaKills: matchParticipant.pentaKills,
        totalDamageChampions: matchParticipant.totalDamageChampions,
        totalDamageTaken: matchParticipant.totalDamageTaken,

        // Vision
        visionScore: matchParticipant.visionScore,
        visionBought: matchParticipant.visionBought,

        // Items
        item0: matchParticipant.item0,
        item1: matchParticipant.item1,
        item2: matchParticipant.item2,
        item3: matchParticipant.item3,
        item4: matchParticipant.item4,
        item5: matchParticipant.item5,
        item6: matchParticipant.item6,

        // Summoner Spells (Alias)
        summonerSpell1Key: sp1.key,
        summonerSpell1Name: sp1.name,
        summonerSpell2Key: sp2.key,
        summonerSpell2Name: sp2.name,

        // Perks/Runes (Alias)
        keystoneIcon: keystone.icon,
        keystoneName: keystone.name,
        substyleIcon: substyle.icon,
        substyleName: substyle.name,
      })
      .from(matchParticipant)
      // Standard Joins
      .innerJoin(customMatch, eq(matchParticipant.customMatchId, customMatch.id))
      .innerJoin(riotAccount, eq(matchParticipant.playerCode, riotAccount.playerCode))
      .innerJoin(champion, eq(matchParticipant.championId, champion.id))
      // Left Joins (Alias 사용)
      .leftJoin(sp1, eq(matchParticipant.summonerSpell1, sp1.id))
      .leftJoin(sp2, eq(matchParticipant.summonerSpell2, sp2.id))
      .leftJoin(keystone, eq(matchParticipant.keyStoneId, keystone.id))
      .leftJoin(substyle, eq(matchParticipant.perkSubStyle, substyle.id))
      // Conditions
      .where(whereCondition)
      .orderBy(desc(customMatch.createDate))
      .limit(limit)
      .offset(offset);
    
    const countQuery = db
      .select({ count: sql<number>`count(*)::integer` })
      .from(matchParticipant)
      .innerJoin(customMatch, eq(matchParticipant.customMatchId, customMatch.id))
      .where(whereCondition);

    const [games, countResult] = await Promise.all([gamesQuery, countQuery]);
    const totalCount = countResult[0]?.count || 0;

    return { games, totalCount };
  }

  /**
   * @desc 게임 상세 조회 (특정 게임의 모든 참가자 정보)
   * 정렬: 팀 -> 포지션(TOP-JUG-MID-ADC-SUP)
   */
  public async getGameDetail(gameId: string, guildId: string) {
    const sp1 = alias(summonerSpell, 'sp1');
    const sp2 = alias(summonerSpell, 'sp2');
    const keystone = alias(perks, 'keystone');
    const substyle = alias(perks, 'substyle');

    return await db
      .select({
        // Game Info
        gameId: customMatch.id,
        season: customMatch.season,
        createDate: customMatch.createDate,
        gameResult: matchParticipant.gameResult,
        gameTeam: matchParticipant.gameTeam,
        timePlayed: matchParticipant.timePlayed,

        // Player Info
        riotName: riotAccount.riotName,
        riotNameTag: riotAccount.riotNameTag,
        
        // Champion Info
        champName: champion.champName,
        champNameEng: champion.champNameEng,
        position: matchParticipant.position,
        level: matchParticipant.level,

        // KDA & Combat
        kill: matchParticipant.kill,
        death: matchParticipant.death,
        assist: matchParticipant.assist,
        pentaKills: matchParticipant.pentaKills,
        totalDamageChampions: matchParticipant.totalDamageChampions,
        totalDamageTaken: matchParticipant.totalDamageTaken,

        // Vision
        visionScore: matchParticipant.visionScore,
        visionBought: matchParticipant.visionBought,

        // Items
        item0: matchParticipant.item0,
        item1: matchParticipant.item1,
        item2: matchParticipant.item2,
        item3: matchParticipant.item3,
        item4: matchParticipant.item4,
        item5: matchParticipant.item5,
        item6: matchParticipant.item6,

        // Summoner Spells
        summonerSpell1Key: sp1.key,
        summonerSpell1Name: sp1.name,
        summonerSpell2Key: sp2.key,
        summonerSpell2Name: sp2.name,

        // Perks/Runes
        keystoneIcon: keystone.icon,
        keystoneName: keystone.name,
        substyleIcon: substyle.icon,
        substyleName: substyle.name,
      })
      .from(matchParticipant)
      .innerJoin(customMatch, eq(matchParticipant.customMatchId, customMatch.id))
      .innerJoin(riotAccount, eq(matchParticipant.playerCode, riotAccount.playerCode))
      .innerJoin(champion, eq(matchParticipant.championId, champion.id))
      .leftJoin(sp1, eq(matchParticipant.summonerSpell1, sp1.id))
      .leftJoin(sp2, eq(matchParticipant.summonerSpell2, sp2.id))
      .leftJoin(keystone, eq(matchParticipant.keyStoneId, keystone.id))
      .leftJoin(substyle, eq(matchParticipant.perkSubStyle, substyle.id))
      .where(and(
        eq(customMatch.id, gameId), 
        eq(customMatch.guildId, guildId), 
        eq(matchParticipant.isDeleted, false),
        eq(customMatch.isDeleted, false)
      ))
      .orderBy(
        matchParticipant.gameTeam, 
        sql`
          CASE ${matchParticipant.position}
            WHEN 'TOP' THEN 1
            WHEN 'JUG' THEN 2
            WHEN 'MID' THEN 3
            WHEN 'ADC' THEN 4
            WHEN 'SUP' THEN 5
            ELSE 6
          END
        `
      );
  }

  /**
   * @desc 시너지 팀원 조회 (함께한 게임 승률 분석)
   * 조건: 같은 팀, 5판 이상 같이 함
   * 필터: 시즌 (Season) 기준
   */
  public async getSynergisticTeammates(
    playerCode: string,
    season: string
  ) {
    // 1. Alias 생성 (Self Join을 위해)
    // mpMe: 기준이 되는 내 전적
    // mpTeammate: 나와 같은 팀인 동료들의 전적
    const mpMe = alias(matchParticipant, 'mp_me');
    const mpTeammate = alias(matchParticipant, 'mp_teammate');

    // 2. 통계 SQL 생성 (팀원 기준 통계)
    const statColumns = this.getStatSqlChunks(mpTeammate);

    const result = await db
      .select({
        riotName: riotAccount.riotName,
        riotNameTag: riotAccount.riotNameTag,
        ...statColumns, // 팀원 기준 승률/KDA
      })
      .from(mpTeammate)
      // Join 1: 내 전적(mpMe)와 팀원 전적(mpTeammate) 연결
      .innerJoin(mpMe, and(
        eq(mpTeammate.customMatchId, mpMe.customMatchId), // 같은 게임
        eq(mpTeammate.gameTeam, mpMe.gameTeam)            // 같은 팀
      ))
      .innerJoin(riotAccount, eq(mpTeammate.playerCode, riotAccount.playerCode))
      .innerJoin(customMatch, eq(mpTeammate.customMatchId, customMatch.id))
      .where(and(
        // 조건 1: 나는 '나'여야 함
        eq(mpMe.playerCode, playerCode),
        // 조건 2: 팀원은 '나'가 아니어야 함
        ne(mpTeammate.playerCode, playerCode),
        // 조건 3: 시즌 필터 
        eq(customMatch.season, season),
        // 조건 4: 삭제되지 않은 데이터
        eq(mpMe.isDeleted, false),
        eq(mpTeammate.isDeleted, false),
        eq(customMatch.isDeleted, false)
      ))
      .groupBy(riotAccount.riotName, riotAccount.riotNameTag)
      .having(sql`count(*) >= 5`) // 5판 이상
      .orderBy(desc(statColumns.winRate)); // 승률 높은 순

    return result;
  }

  /**
   * @desc 게임 기록 소프트 삭제
   * customMatch와 연관된 matchParticipant를 모두 isDeleted = true 처리
   */
  public async deleteMatch(gameId: string, guildId: string) {
    return await db.transaction(async (tx) => {
      // 1. CustomMatch 삭제
      const [deletedMatch] = await tx
        .update(customMatch)
        .set({ isDeleted: true })
        .where(and(
          eq(customMatch.id, gameId),
          eq(customMatch.guildId, guildId),
          eq(customMatch.isDeleted, false)
        ))
        .returning();

      // 해당 게임이 없거나 이미 삭제된 경우 null 반환
      if (!deletedMatch) {
        return null;
      }

      // 2. 연관된 MatchParticipant 일괄 삭제
      await tx
        .update(matchParticipant)
        .set({ isDeleted: true })
        .where(and(
          eq(matchParticipant.customMatchId, gameId),
          eq(matchParticipant.isDeleted, false)
        ));

      return deletedMatch;
    });
  }
}

export const matchParticipantService = new MatchParticipantService();
