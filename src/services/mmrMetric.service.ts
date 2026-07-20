import { inArray } from 'drizzle-orm';
import { db, DbOrTx, TransactionType } from '../database/connectionPool.js';
import { champion, mmrParticipantMetric, InsertMmrParticipantMetric } from '../database/schema.js';
import { SystemError } from '../types/error.js';

/**
 * @desc mmr_participant_metric 적재 서비스
 * 한 row = 한 경기의 한 참가자. 원천 = replay.raw_data 배열.
 * 변환·파생 산식은 backfill SQL과 수치가 정확히 일치해야 한다.
 * 구현 가이드(스키마·적재·파생·backfill): Confluence [개발팀] > [Back] > "mmr_participant_metric 스키마·적재 구현 가이드".
 */

const MIN_TIME_PLAYED_SECONDS = 300; // 5분 미만 제외
const SURRENDER_MIN_SECONDS = 900; // 15분 미만 '항복' 경기 제외
const POSITIONS = ['TOP', 'JUG', 'MID', 'ADC', 'SUP'] as const;

/** raw_data 값은 전부 문자열("168"). 파싱 실패 시 null */
const toIntOrNull = (v?: string | null): number | null => {
  const n = parseInt(v ?? '', 10);
  return Number.isNaN(n) ? null : n;
};

/** metric 컬럼(camelCase) ← rawData JSON 키. ⚠️ WARD_PLACED / WARD_KILLED 는 단수형 */
const RAW_KEY_MAP = {
  kills: 'CHAMPIONS_KILLED',
  deaths: 'NUM_DEATHS',
  assists: 'ASSISTS',
  doubleKills: 'DOUBLE_KILLS',
  tripleKills: 'TRIPLE_KILLS',
  quadraKills: 'QUADRA_KILLS',
  pentaKills: 'PENTA_KILLS',
  killingSprees: 'KILLING_SPREES',
  largestKillingSpree: 'LARGEST_KILLING_SPREE',
  goldEarned: 'GOLD_EARNED',
  ccTime: 'TIME_CCING_OTHERS',
  gameDuration: 'TIME_PLAYED',
  damageToChampions: 'TOTAL_DAMAGE_DEALT_TO_CHAMPIONS',
  damageTaken: 'TOTAL_DAMAGE_TAKEN',
  damageSelfMitigated: 'TOTAL_DAMAGE_SELF_MITIGATED',
  visionScore: 'VISION_SCORE',
  wardsPlaced: 'WARD_PLACED',
  wardsKilled: 'WARD_KILLED',
  detectorWardsPlaced: 'WARD_PLACED_DETECTOR',
  controlWardsBought: 'VISION_WARDS_BOUGHT_IN_GAME',
  minionsKilled: 'MINIONS_KILLED',
  neutralMinionsKilled: 'NEUTRAL_MINIONS_KILLED',
  timeSpentDead: 'TOTAL_TIME_SPENT_DEAD',
  longestTimeLiving: 'LONGEST_TIME_SPENT_LIVING',
  damageToTurrets: 'TOTAL_DAMAGE_DEALT_TO_BUILDINGS',
  damageToObjectives: 'TOTAL_DAMAGE_DEALT_TO_OBJECTIVES',
  dragonKills: 'DRAGON_KILLS',
  baronKills: 'BARON_KILLS',
  heraldKills: 'RIFT_HERALD_KILLS',
  hordeKills: 'HORDE_KILLS',
  lastTakedownTime: 'LAST_TAKEDOWN_TIME',
  turretsKilled: 'TURRETS_KILLED',
  turretTakedowns: 'TURRET_TAKEDOWNS',
  level: 'LEVEL',
  exp: 'EXP',
  turretPlatesDestroyed: 'Missions_TurretPlatesDestroyed',
  takedownsUnderTurret: 'Missions_TakedownsUnderTurret',
  takedownsBefore15Min: 'Missions_TakedownsBefore15Min',
  jungleCsOwn: 'NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE',
  jungleCsEnemy: 'NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE',
  damageToEpicMonsters: 'TOTAL_DAMAGE_DEALT_TO_EPIC_MONSTERS',
  objectivesStolen: 'OBJECTIVES_STOLEN',
  barracksKilled: 'BARRACKS_KILLED',
  healOnTeammates: 'TOTAL_HEAL_ON_TEAMMATES',
  shieldOnTeammates: 'TOTAL_DAMAGE_SHIELDED_ON_TEAMMATES',
  enemyMissingPings: 'ENEMY_MISSING_PINGS',
  retreatPings: 'RETREAT_PINGS',
  onMyWayPings: 'ON_MY_WAY_PINGS',
  commandPings: 'COMMAND_PINGS',
} as const; // 49개

type RawMetricCol = keyof typeof RAW_KEY_MAP;

/** TEAM '100'/'200' → blue/red (backfill CASE와 동일) */
const mapTeam = (team?: string): string => {
  if (team === '100') return 'blue';
  if (team === '200') return 'red';
  return team ?? '';
};

/** TEAM_POSITION → enum (backfill CASE와 동일) */
const mapPosition = (pos?: string): string => {
  switch (pos) {
    case 'TOP':
      return 'TOP';
    case 'JUNGLE':
      return 'JUG';
    case 'MIDDLE':
      return 'MID';
    case 'BOTTOM':
      return 'ADC';
    case 'UTILITY':
      return 'SUP';
    default:
      return pos ?? '';
  }
};

export interface BuildMetricRowsInput {
  rawData: Array<Record<string, string | undefined>>;
  customMatchId: string;
  guildId: string;
  season: string;
  playedDate: Date;
  /** puuid → 실제 계정 playerCode (병합 없음, match_participant와 동일 — TRC-243 A안).
   *  본계정 합산은 조회 시점에 subAccountLink 헬퍼로 해석한다. */
  puuidToPlayerCodeMap: Map<string, string>;
}

export class MmrMetricService {
  /**
   * @desc rawData 배열 → mmr_participant_metric insert 행 배열
   * categoricals·championId·파생 모두 rawData 기준으로 backfill SQL과 동일하게 변환한다.
   */
  public async buildMetricRows(
    input: BuildMetricRowsInput,
    executor: DbOrTx = db,
  ): Promise<InsertMmrParticipantMetric[]> {
    const { rawData, customMatchId, guildId, season, playedDate, puuidToPlayerCodeMap } = input;

    // championId: SKIN(영문 챔프명) → champion.id, 실패 시 NULL (backfill LEFT JOIN과 동일)
    const championMap = await this.buildChampionMap(rawData, executor);

    const rows: InsertMmrParticipantMetric[] = rawData.map((p) => {
      if (!p.PUUID) throw new SystemError('metric build mismatch: PUUID missing', 500);

      const raw = Object.fromEntries(
        (Object.keys(RAW_KEY_MAP) as RawMetricCol[]).map((col) => [
          col,
          toIntOrNull(p[RAW_KEY_MAP[col]]),
        ]),
      ) as Record<RawMetricCol, number | null>;

      return {
        customMatchId,
        puuid: p.PUUID,
        playerCode: puuidToPlayerCodeMap.get(p.PUUID) ?? null,
        guildId,
        season,
        championId: championMap.get(p.SKIN ?? '') ?? null,
        gameTeam: mapTeam(p.TEAM),
        position: mapPosition(p.TEAM_POSITION),
        gameResult: p.WIN === 'Win' ? 1 : 0,
        playedDate,
        ...raw,
        isMmrEligible: this.judgeIsMmrEligible({
          timePlayed: raw.gameDuration ?? 0,
          totalDamageChampions: raw.damageToChampions ?? 0,
          kill: raw.kills ?? 0,
          assist: raw.assists ?? 0,
          endedInSurrender: p.GAME_ENDED_IN_SURRENDER === '1',
        }),
      } satisfies InsertMmrParticipantMetric;
    });

    return this.addDerivedMetrics(rows);
  }

  /** @desc insert 실행 (행 없으면 skip) */
  public async insertMetrics(rows: InsertMmrParticipantMetric[], tx: TransactionType) {
    if (rows.length === 0) return [];
    try {
      return await tx.insert(mmrParticipantMetric).values(rows).returning();
    } catch (error) {
      console.error('Error inserting mmr participant metrics', error);
      throw new SystemError('mmr participant metric error while inserting', 500);
    }
  }

  /**
   * @desc per-row MMR 적격 판정
   * 5분 미만 / 15분 미만 항복 / AFK 의심(피해0·K+A0) 제외
   */
  public judgeIsMmrEligible(a: {
    timePlayed: number;
    totalDamageChampions: number;
    kill: number;
    assist: number;
    endedInSurrender: boolean;
  }): boolean {
    if (a.timePlayed < MIN_TIME_PLAYED_SECONDS) return false;
    if (a.endedInSurrender && a.timePlayed < SURRENDER_MIN_SECONDS) return false;
    if (a.totalDamageChampions === 0 && a.kill + a.assist === 0) return false;
    return true;
  }

  /**
   * @desc 경기 단위 MMR 적격 (10명 · 5포지션 각 2명 · 전원 per-row 적격)
   * true → queue 'wait', false → 'skip'. (큐 등록은 이번 범위 밖, 추후 사용)
   */
  public isMatchEligibleForMmr(rows: InsertMmrParticipantMetric[]): boolean {
    if (rows.length !== 10) return false;
    if (!rows.every((r) => r.isMmrEligible !== false)) return false;
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.position, (counts.get(r.position) ?? 0) + 1);
    return POSITIONS.every((p) => counts.get(p) === 2);
  }

  // ── private ──

  /** SKIN(champ_name_eng) → champion.id Map. 매핑 실패 챔프는 Map에 없음 → 호출부에서 null */
  private async buildChampionMap(
    rawData: Array<Record<string, string | undefined>>,
    executor: DbOrTx = db,
  ): Promise<Map<string, string>> {
    const skins = [...new Set(rawData.map((p) => p.SKIN).filter((s): s is string => !!s))];
    if (skins.length === 0) return new Map();

    const records = await executor
      .select({ id: champion.id, nameEng: champion.champNameEng })
      .from(champion)
      .where(inArray(champion.champNameEng, skins));

    const map = new Map<string, string>();
    for (const r of records) {
      if (r.nameEng) map.set(r.nameEng, r.id);
    }
    return map;
  }

  /**
   * @desc 파생 14개 산식 (backfill SQL §5.3과 수치 정확 일치)
   * minutes = ROUND(game_duration/60, 2) 선반올림 후 분모로 사용.
   * 분모 0/NULL → 0. 결과는 소수 2자리.
   */
  private addDerivedMetrics(rows: InsertMmrParticipantMetric[]): InsertMmrParticipantMetric[] {
    // position별 그룹(같은 경기) — lane_gold_diff 계산용
    const byPosition = new Map<string, InsertMmrParticipantMetric[]>();
    for (const r of rows) {
      const arr = byPosition.get(r.position) ?? [];
      arr.push(r);
      byPosition.set(r.position, arr);
    }

    const round2 = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
    /** 분모 0/NULL·numerator NULL → '0' */
    const ratio = (num: number | null | undefined, denom: number): string => {
      if (num == null || denom === 0) return '0';
      return round2(num / denom);
    };

    return rows.map((r) => {
      const minutes = Math.round(((r.gameDuration ?? 0) / 60) * 100) / 100;
      const deathsSafe = (r.deaths ?? 0) === 0 ? 1 : (r.deaths as number);
      const cs = (r.minionsKilled ?? 0) + (r.neutralMinionsKilled ?? 0);

      // lane_gold_diff = gold_earned − (같은 경기·같은 position 상대들의 평균 gold)
      const group = byPosition.get(r.position) ?? [];
      const opponents = group.filter((o) => o !== r);
      let laneGoldDiff = '0';
      if (r.goldEarned != null && opponents.length > 0) {
        const oppGoldSum = opponents.reduce((s, o) => s + (o.goldEarned ?? 0), 0);
        laneGoldDiff = round2(r.goldEarned - oppGoldSum / opponents.length);
      }

      // dead_time_pct = time_spent_dead / (분 * 60) * 100
      const deadDenom = minutes * 60;
      const deadTimePct =
        r.timeSpentDead == null || deadDenom === 0
          ? '0'
          : round2((r.timeSpentDead / deadDenom) * 100);

      return {
        ...r,
        goldPerMin: ratio(r.goldEarned, minutes),
        dpm: ratio(r.damageToChampions, minutes),
        damageTakenPerMin: ratio(r.damageTaken, minutes),
        ccTimePerMin: ratio(r.ccTime, minutes),
        expPerMin: ratio(r.exp, minutes),
        damageToTurretsPerMin: ratio(r.damageToTurrets, minutes),
        csPerMin: ratio(cs, minutes),
        wardsPlacedPerMin: ratio(r.wardsPlaced, minutes),
        wardsKilledPerMin: ratio(r.wardsKilled, minutes),
        kda: ratio((r.kills ?? 0) + (r.assists ?? 0), deathsSafe),
        damageTakenPerDeath: ratio(r.damageTaken, deathsSafe),
        damageDealtPerDeath: ratio(r.damageToChampions, deathsSafe),
        deadTimePct,
        laneGoldDiff,
      } satisfies InsertMmrParticipantMetric;
    });
  }
}

export const mmrMetricService = new MmrMetricService();
