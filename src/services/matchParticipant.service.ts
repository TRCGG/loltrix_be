import { z } from 'zod';
import { eq, and, like, desc, sql, is, inArray } from 'drizzle-orm'; // 'inArray' 추가
import { db, TransactionType } from '../database/connectionPool.js';
import { InsertMatchParticipant, matchParticipant, champion } from '../database/schema.js';
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
  public async insertMatchParticipants(rawData: any[], customMatchId: string, tx: TransactionType) {
    try {
      // 1. rawData를 파싱하고 챔피언 ID로 변환 (await 필요)
      const newData = await this.parsedMatchParticipant(rawData, customMatchId);

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
   * @param rawData - Zod 스키마에 의해 검증될 알 수 없는 데이터
   * @param customMatchId - 이 참가자들이 속한 custom_match의 ID
   * @returns InsertMatchParticipant 타입의 객체 배열 Promise
   */
  private async parsedMatchParticipant(
    rawData: any,
    customMatchId: string,
  ): Promise<InsertMatchParticipant[]> {
    // Zod를 사용하여 원본 데이터 검증
    const validatedData = MatchparticipantArraySchema.parse(rawData);

    // 1. 필요한 모든 챔피언 영문 이름(d.SKIN)을 중복 없이 추출합니다.
    const championEngNames = [...new Set(validatedData.map((d) => d.SKIN).filter(Boolean))];

    // 2. DB 조회를 *단 한 번* 실행하여, 챔피언 영문 이름과 ID 맵
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

      return {
        customMatchId: customMatchId,
        puuid: d.PUUID,
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
}

export const matchParticipantService = new MatchParticipantService();
