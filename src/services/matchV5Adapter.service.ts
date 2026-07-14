import { MatchV5Dto, MatchV5Participant } from '../clients/riot/index.js';
import { InsertMatchBan } from '../database/schema.js';

/**
 * @desc Match-V5 JSON → 기존 적재 경로 입력형 정규화 어댑터.
 *
 * 설계 결정(리플 경로 재사용):
 *  - 참가자는 리플 경로가 쓰는 **rawData(대문자 키 문자열) 배열** 형태로 정규화한다.
 *    이렇게 하면 riotAccountService.upsertRiotAccount / matchParticipantService.insertMatchParticipants
 *    / mmrMetricService.buildMetricRows 를 리플 경로와 **동일하게** 재사용할 수 있어
 *    KDA·아이템·룬·CS·position 매핑과 mmr 지표(파생 14 + 적격 판정)가 의미상 정확히 일치한다.
 *  - championId는 SKIN=championName 으로 넣어 기존 champNameEng→champion.id 조회를 그대로 탄다.
 *    match-v5의 championName은 DataDragon id와 동일(프론트가 이 값으로 이미지 URL 구성)하므로
 *    리플 경로에서 간혹 나던 SKIN 매핑 문제가 없다.
 *  - 밴은 기존 서비스가 없으므로 match_ban 입력행(InsertMatchBan)으로 직접 만든다.
 *
 * rawData 값은 전부 문자열(리플 statsJson과 동일 규약). 파싱은 하위 서비스(parseInt/Zod)가 담당.
 */

/** 매핑에 쓰는 rawData 1행. 값은 문자열 또는 미존재(undefined). */
export type NormalizedRawParticipant = Record<string, string | undefined>;

/** 밴 없음(-1) 챔피언 sentinel. */
const NO_BAN_CHAMPION = -1;

/** teamId 100/200 → blue/red (match_ban.team 저장값). */
const mapBanTeam = (teamId: number): string => {
  if (teamId === 100) return 'blue';
  if (teamId === 200) return 'red';
  return String(teamId);
};

/** 필수 숫자 필드: 누락 시 '0'. (match_participant NOT NULL 컬럼 대응) */
const reqStr = (v: number | null | undefined): string => (v === undefined || v === null ? '0' : String(v));

/** 선택 숫자 필드: 누락 시 undefined → 하위에서 NULL. */
const optStr = (v: number | null | undefined): string | undefined =>
  v === undefined || v === null ? undefined : String(v);

export class MatchV5AdapterService {
  /** metadata.matchId (예: 'KR_1234567890'). custom_match.id로 사용. */
  public getMatchId(matchV5: MatchV5Dto): string {
    return matchV5.metadata.matchId;
  }

  /** played_date = info.gameStartTimestamp(epoch ms). 없으면 현재 시각으로 폴백. */
  public getPlayedDate(matchV5: MatchV5Dto): Date {
    const ts = matchV5.info.gameStartTimestamp;
    return ts ? new Date(ts) : new Date();
  }

  /**
   * @desc participants → 리플 경로 rawData(대문자 키) 배열.
   * riot_account / match_participant / mmr_participant_metric 세 경로가 공통으로 소비한다.
   */
  public toRawParticipants(matchV5: MatchV5Dto): NormalizedRawParticipant[] {
    return matchV5.info.participants.map((p) => this.toRawParticipant(p));
  }

  /**
   * @desc teams[].bans[] → match_ban 입력행.
   * championId -1 → NULL, team 100→blue/200→red, ban_order = pickTurn.
   */
  public toBanRows(matchV5: MatchV5Dto, customMatchId: string): InsertMatchBan[] {
    const rows: InsertMatchBan[] = [];
    for (const team of matchV5.info.teams ?? []) {
      const teamName = mapBanTeam(team.teamId);
      for (const ban of team.bans ?? []) {
        rows.push({
          customMatchId,
          team: teamName,
          championId: ban.championId === NO_BAN_CHAMPION ? null : String(ban.championId),
          banOrder: ban.pickTurn,
        });
      }
    }
    return rows;
  }

  // ── private ──

  private toRawParticipant(p: MatchV5Participant): NormalizedRawParticipant {
    const perks = this.mapPerks(p);
    const ch = p.challenges ?? {};

    return {
      // 계정 (riotAccountService)
      PUUID: p.puuid,
      RIOT_ID_GAME_NAME: (p.riotIdGameName || p.summonerName || 'Unknown').trim() || 'Unknown',
      RIOT_ID_TAG_LINE: (p.riotIdTagline || '').trim() || 'NA1',

      // 카테고리 (양 경로 공통)
      SKIN: p.championName,
      TEAM: String(p.teamId),
      WIN: p.win ? 'Win' : 'Fail',
      TEAM_POSITION: p.teamPosition,
      GAME_ENDED_IN_SURRENDER: p.gameEndedInSurrender ? '1' : '0',

      // match_participant NOT NULL 지표
      CHAMPIONS_KILLED: reqStr(p.kills),
      NUM_DEATHS: reqStr(p.deaths),
      ASSISTS: reqStr(p.assists),
      GOLD_EARNED: reqStr(p.goldEarned),
      TIME_CCING_OTHERS: reqStr(p.timeCCingOthers),
      EXP: reqStr(p.champExperience),
      TIME_PLAYED: reqStr(p.timePlayed),
      TOTAL_DAMAGE_DEALT_TO_CHAMPIONS: reqStr(p.totalDamageDealtToChampions),
      TOTAL_DAMAGE_DEALT_TO_BUILDINGS: reqStr(p.damageDealtToBuildings),
      TOTAL_DAMAGE_TAKEN: reqStr(p.totalDamageTaken),
      VISION_SCORE: reqStr(p.visionScore),
      VISION_WARDS_BOUGHT_IN_GAME: reqStr(p.visionWardsBoughtInGame),
      LEVEL: reqStr(p.champLevel),
      ITEM0: reqStr(p.item0),
      ITEM1: reqStr(p.item1),
      ITEM2: reqStr(p.item2),
      ITEM3: reqStr(p.item3),
      ITEM4: reqStr(p.item4),
      ITEM5: reqStr(p.item5),
      ITEM6: reqStr(p.item6),
      KEYSTONE_ID: perks.KEYSTONE_ID,
      PERK_SUB_STYLE: perks.PERK_SUB_STYLE,

      // match_participant 선택 지표
      PENTA_KILLS: optStr(p.pentaKills),
      SUMMONER_SPELL_1: optStr(p.summoner1Id),
      SUMMONER_SPELL_2: optStr(p.summoner2Id),
      PERK0: perks.PERK0,
      PERK1: perks.PERK1,
      PERK2: perks.PERK2,
      PERK3: perks.PERK3,
      PERK4: perks.PERK4,
      PERK5: perks.PERK5,
      MINIONS_KILLED: optStr(p.totalMinionsKilled),
      NEUTRAL_MINIONS_KILLED: optStr(p.neutralMinionsKilled),
      // match-v5 참가자는 자군/적군 정글 CS를 직접 주지 않음 → NULL.
      NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE: undefined,
      NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE: undefined,

      // mmr_participant_metric 추가 raw 지표 (전부 nullable)
      DOUBLE_KILLS: optStr(p.doubleKills),
      TRIPLE_KILLS: optStr(p.tripleKills),
      QUADRA_KILLS: optStr(p.quadraKills),
      KILLING_SPREES: optStr(p.killingSprees),
      LARGEST_KILLING_SPREE: optStr(p.largestKillingSpree),
      TOTAL_DAMAGE_SELF_MITIGATED: optStr(p.damageSelfMitigated),
      WARD_PLACED: optStr(p.wardsPlaced),
      WARD_KILLED: optStr(p.wardsKilled),
      WARD_PLACED_DETECTOR: optStr(p.detectorWardsPlaced),
      TOTAL_TIME_SPENT_DEAD: optStr(p.totalTimeSpentDead),
      LONGEST_TIME_SPENT_LIVING: optStr(p.longestTimeSpentLiving),
      TOTAL_DAMAGE_DEALT_TO_OBJECTIVES: optStr(p.damageDealtToObjectives),
      DRAGON_KILLS: optStr(p.dragonKills),
      BARON_KILLS: optStr(p.baronKills),
      TURRETS_KILLED: optStr(p.turretKills),
      TURRET_TAKEDOWNS: optStr(p.turretTakedowns),
      OBJECTIVES_STOLEN: optStr(p.objectivesStolen),
      // BARRACKS(=억제기) 파괴 == match-v5 inhibitorKills.
      BARRACKS_KILLED: optStr(p.inhibitorKills),
      TOTAL_HEAL_ON_TEAMMATES: optStr(p.totalHealsOnTeammates),
      TOTAL_DAMAGE_SHIELDED_ON_TEAMMATES: optStr(p.totalDamageShieldedOnTeammates),
      ENEMY_MISSING_PINGS: optStr(p.enemyMissingPings),
      RETREAT_PINGS: optStr(p.retreatPings),
      ON_MY_WAY_PINGS: optStr(p.onMyWayPings),
      COMMAND_PINGS: optStr(p.commandPings),
      // challenges 동등 지표: 포탑 방패 파괴만 명확 매핑, 나머지 애매 지표는 NULL로 둔다.
      Missions_TurretPlatesDestroyed: optStr(ch.turretPlatesTaken),
    };
  }

  /**
   * @desc perks.styles → 대문자 키. KEYSTONE_ID/PERK_SUB_STYLE은 NOT NULL이라 '0' 폴백.
   * primary(첫 트리) selections[0]=키스톤, subStyle 트리의 style=보조 트리 id.
   */
  private mapPerks(p: MatchV5Participant): {
    KEYSTONE_ID: string;
    PERK_SUB_STYLE: string;
    PERK0?: string;
    PERK1?: string;
    PERK2?: string;
    PERK3?: string;
    PERK4?: string;
    PERK5?: string;
  } {
    const styles = p.perks?.styles ?? [];
    const primary = styles.find((s) => s.description === 'primaryStyle') ?? styles[0];
    const sub = styles.find((s) => s.description === 'subStyle') ?? styles[1];
    const pSel = primary?.selections ?? [];
    const sSel = sub?.selections ?? [];

    return {
      KEYSTONE_ID: reqStr(pSel[0]?.perk),
      PERK_SUB_STYLE: reqStr(sub?.style),
      PERK0: optStr(pSel[0]?.perk),
      PERK1: optStr(pSel[1]?.perk),
      PERK2: optStr(pSel[2]?.perk),
      PERK3: optStr(pSel[3]?.perk),
      PERK4: optStr(sSel[0]?.perk),
      PERK5: optStr(sSel[1]?.perk),
    };
  }
}

export const matchV5AdapterService = new MatchV5AdapterService();
