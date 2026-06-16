import { and, eq, ne, sql, SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../database/connectionPool.js';
import { mmrParticipantMetric, riotAccount, guildMember, champion } from '../database/schema.js';
import {
  FrequentH2hItem,
  H2hProfile,
  H2hMetrics,
  H2hMatchup,
  H2hInsight,
  H2hRecentItem,
  H2hRecentDetailSide,
  H2hAgainst,
  H2hTogether,
  H2hLaneCombo,
  H2hDuoChamp,
  H2hDetail,
  LaneMatrix,
  LaneTopFaced,
  SeasonBreak,
} from '../types/h2h.js';

const LANES = ['TOP', 'JUG', 'MID', 'ADC', 'SUP'] as const;

/** numeric(string)·int → number|null */
const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isNaN(n) ? null : n;
};

/** null 제외 평균 (소수 2자리). 전부 null이면 null */
const avg = (vals: (number | null)[]): number | null => {
  const xs = vals.filter((x): x is number => x !== null);
  if (xs.length === 0) return null;
  return Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100;
};

/**
 * @desc 상대전적(H2H) 서비스 — mmr_participant_metric 기반.
 * metric.player_code는 적재 시 본계정으로 병합 저장되므로(match_participant와 동일),
 * H2H 식별·집계는 player_code 기준 단순 조인으로 처리한다.
 * 기준 유저는 컨트롤러가 riotName 검색으로 활성 본계정 playerCode를 해석해 넘긴다.
 */
export class H2hService {
  /**
   * @desc 기준 유저(mePlayerCode)가 맞붙은(다른 팀) 상대를 본계정 단위로 집계. 시즌 기준(season=null이면 전체).
   * 활성 메인 멤버만 노출. q가 있으면 riotName#tag 부분일치 필터. matchups DESC.
   */
  public async getFrequentOpponents(
    guildId: string,
    mePlayerCode: string,
    options: { q?: string; limit?: string; season: string | null },
  ): Promise<FrequentH2hItem[]> {
    const { q, limit = '10', season } = options;
    const limitNum = Number(limit);

    const mpmMe = alias(mmrParticipantMetric, 'mpm_me');
    const mpmOp = alias(mmrParticipantMetric, 'mpm_op');
    const seasonFilter = season === null ? undefined : eq(mpmMe.season, season);

    const matchupsExpr = sql<number>`COUNT(DISTINCT ${mpmMe.customMatchId})::integer`;
    const winsExpr = sql<number>`COUNT(DISTINCT CASE WHEN ${mpmMe.gameResult} = 1 THEN ${mpmMe.customMatchId} END)::integer`;

    const rows = await db
      .select({
        puuid: riotAccount.puuid,
        riotName: riotAccount.riotName,
        riotNameTag: riotAccount.riotNameTag,
        mainLane: sql<string>`MODE() WITHIN GROUP (ORDER BY ${mpmOp.position})`,
        matchups: matchupsExpr,
        wins: winsExpr,
        lastPlayedDate: sql<Date>`MAX(${mpmMe.playedDate})`,
      })
      .from(mpmMe)
      .innerJoin(mpmOp, eq(mpmMe.customMatchId, mpmOp.customMatchId))
      // 상대 본계정이 활성 메인 멤버일 때만
      .innerJoin(
        guildMember,
        and(
          eq(guildMember.account, mpmOp.playerCode),
          eq(guildMember.guildId, guildId),
          eq(guildMember.isMain, true),
          eq(guildMember.status, '1'),
          eq(guildMember.isDeleted, false),
        ),
      )
      .innerJoin(riotAccount, eq(riotAccount.playerCode, mpmOp.playerCode))
      .where(
        and(
          eq(mpmMe.playerCode, mePlayerCode),
          eq(mpmMe.guildId, guildId),
          ne(mpmOp.playerCode, mePlayerCode), // 내 계정군 제외
          ne(mpmMe.gameTeam, mpmOp.gameTeam), // 맞붙은(다른 팀)
          eq(mpmMe.isDeleted, false),
          eq(mpmOp.isDeleted, false),
          seasonFilter,
        ),
      )
      .groupBy(riotAccount.puuid, riotAccount.riotName, riotAccount.riotNameTag);

    let items: FrequentH2hItem[] = rows.map((r) => ({
      puuid: r.puuid,
      riotName: r.riotName,
      riotNameTag: r.riotNameTag,
      mainLane: r.mainLane,
      matchups: r.matchups,
      winRate: r.matchups === 0 ? 0 : Math.round((r.wins / r.matchups) * 1000) / 10,
      // MAX() 집계는 문자열로 올 수 있어 Date로 정규화 (정렬에서 getTime 사용)
      lastPlayedDate: new Date(r.lastPlayedDate),
    }));

    // q 부분일치 (riotName#tag, 공백·대소문자 무시)
    if (q && q.trim()) {
      const needle = q.replace(/\s+/g, '').toLowerCase();
      items = items.filter((it) =>
        `${it.riotName}#${it.riotNameTag}`.replace(/\s+/g, '').toLowerCase().includes(needle),
      );
    }

    items.sort(
      (a, b) => b.matchups - a.matchups || b.lastPlayedDate.getTime() - a.lastPlayedDate.getTime(),
    );

    return items.slice(0, limitNum);
  }

  // ──────────────────────────────────────────────
  // 상대전적 상세 (GET /h2h) — against 블록
  // ──────────────────────────────────────────────

  /**
   * @desc me/oppo 상세 상대전적. season=null이면 전체 시즌.
   * 두 playerCode는 컨트롤러가 riotName 검색으로 해석해 넘긴다.
   */
  public async getH2hDetail(
    guildId: string,
    mePlayerCode: string,
    oppoPlayerCode: string,
    opts: { season: string | null; recentLimit: number; recentOffset: number },
  ): Promise<H2hDetail> {
    const { season, recentLimit, recentOffset } = opts;

    const [me, oppo, meta, againstRows, togetherRows] = await Promise.all([
      this.getProfile(guildId, mePlayerCode, season),
      this.getProfile(guildId, oppoPlayerCode, season),
      this.getMeta(guildId, mePlayerCode, oppoPlayerCode, season),
      this.queryAgainstRawRows(guildId, mePlayerCode, oppoPlayerCode, season),
      this.queryTogetherRawRows(guildId, mePlayerCode, oppoPlayerCode, season),
    ]);

    const against = this.buildAgainst(againstRows, me.seasonAvgKda, recentLimit, recentOffset);
    const together = this.buildTogether(togetherRows);

    return {
      me: me.profile,
      oppo: oppo.profile,
      totalMet: meta.totalMet,
      firstMet: meta.firstMet,
      lastMet: meta.lastMet,
      against,
      together,
    };
  }

  /** @desc 시즌 조건 (null이면 전체) */
  private seasonCond(season: string | null): SQL | undefined {
    return season === null ? undefined : eq(mmrParticipantMetric.season, season);
  }

  /**
   * @desc 프로필 (puuid·riotName·tag + 시즌 mostLane·seasonWR) + 시즌 평균 KDA.
   * seasonAvgKda는 matchups kdaDiff 기준값으로 재사용 (시즌 게임 1회 스캔). mmr은 항상 null.
   */
  private async getProfile(
    guildId: string,
    playerCode: string,
    season: string | null,
  ): Promise<{ profile: H2hProfile; seasonAvgKda: number | null }> {
    const [ra] = await db
      .select({
        puuid: riotAccount.puuid,
        riotName: riotAccount.riotName,
        riotNameTag: riotAccount.riotNameTag,
      })
      .from(riotAccount)
      .where(eq(riotAccount.playerCode, playerCode))
      .limit(1);

    const [agg] = await db
      .select({
        mostLane: sql<
          string | null
        >`MODE() WITHIN GROUP (ORDER BY ${mmrParticipantMetric.position})`,
        total: sql<number>`COUNT(*)::integer`,
        wins: sql<number>`SUM(CASE WHEN ${mmrParticipantMetric.gameResult} = 1 THEN 1 ELSE 0 END)::integer`,
        avgKda: sql<string | null>`AVG(${mmrParticipantMetric.kda})`,
      })
      .from(mmrParticipantMetric)
      .where(
        and(
          eq(mmrParticipantMetric.playerCode, playerCode),
          eq(mmrParticipantMetric.guildId, guildId),
          eq(mmrParticipantMetric.isDeleted, false),
          this.seasonCond(season),
        ),
      );

    const total = agg?.total ?? 0;
    return {
      profile: {
        puuid: ra?.puuid ?? '',
        riotName: ra?.riotName ?? '',
        riotNameTag: ra?.riotNameTag ?? '',
        mmr: null,
        mostLane: total > 0 ? (agg?.mostLane ?? null) : null,
        seasonWR: total > 0 ? Math.round(((agg?.wins ?? 0) / total) * 1000) / 10 : null,
      },
      seasonAvgKda: num(agg?.avgKda ?? null),
    };
  }

  /** @desc 함께+맞붙은 총 게임 수·첫/마지막 만남 (팀 무관) */
  private async getMeta(
    guildId: string,
    mePlayerCode: string,
    oppoPlayerCode: string,
    season: string | null,
  ): Promise<{ totalMet: number; firstMet: Date | null; lastMet: Date | null }> {
    const mp = alias(mmrParticipantMetric, 'mp_meta');
    const op = alias(mmrParticipantMetric, 'op_meta');
    const seasonFilter = season === null ? undefined : eq(mp.season, season);

    const [r] = await db
      .select({
        totalMet: sql<number>`COUNT(DISTINCT ${mp.customMatchId})::integer`,
        firstMet: sql<Date | null>`MIN(${mp.playedDate})`,
        lastMet: sql<Date | null>`MAX(${mp.playedDate})`,
      })
      .from(mp)
      .innerJoin(op, eq(mp.customMatchId, op.customMatchId))
      .where(
        and(
          eq(mp.playerCode, mePlayerCode),
          eq(op.playerCode, oppoPlayerCode),
          eq(mp.guildId, guildId),
          eq(mp.isDeleted, false),
          eq(op.isDeleted, false),
          seasonFilter,
        ),
      );

    // MIN/MAX 집계는 문자열로 올 수 있어 Date로 정규화 (JSON ISO 출력)
    return {
      totalMet: r?.totalMet ?? 0,
      firstMet: r?.firstMet ? new Date(r.firstMet) : null,
      lastMet: r?.lastMet ? new Date(r.lastMet) : null,
    };
  }

  /** @desc 맞붙은(다른 팀) 게임 raw 한 쌍씩 (me·oppo 컬럼). played_date ASC (스트릭용) */
  private async queryAgainstRawRows(
    guildId: string,
    mePlayerCode: string,
    oppoPlayerCode: string,
    season: string | null,
  ) {
    const mp = alias(mmrParticipantMetric, 'mp_ag');
    const op = alias(mmrParticipantMetric, 'op_ag');
    const cMp = alias(champion, 'champ_mp');
    const cOp = alias(champion, 'champ_op');
    const seasonFilter = season === null ? undefined : eq(mp.season, season);

    return db
      .select({
        meCustomMatchId: mp.customMatchId,
        mePlayedDate: mp.playedDate,
        meSeason: mp.season,
        meResult: mp.gameResult,
        mePosition: mp.position,
        meChampionId: mp.championId,
        meChamp: cMp.champNameEng,
        meKills: mp.kills,
        meDeaths: mp.deaths,
        meAssists: mp.assists,
        meGameLen: mp.gameDuration,
        meKda: mp.kda,
        meDpm: mp.dpm,
        meLaneGoldDiff: mp.laneGoldDiff,
        meTd15: mp.takedownsBefore15Min,
        mePlates: mp.turretPlatesDestroyed,
        meExpPerMin: mp.expPerMin,
        meDeadPct: mp.deadTimePct,
        meJungleCsEnemy: mp.jungleCsEnemy,
        meDmg: mp.damageToChampions,
        meTaken: mp.damageTaken,
        meSelfMit: mp.damageSelfMitigated,
        meGold: mp.goldEarned,
        meMinions: mp.minionsKilled,
        meNeutral: mp.neutralMinionsKilled,
        meVision: mp.visionScore,
        meWardsP: mp.wardsPlaced,
        meWardsK: mp.wardsKilled,
        meControlW: mp.controlWardsBought,
        meCcTime: mp.ccTime,
        meUnderTurretTd: mp.takedownsUnderTurret,
        meTurretTd: mp.turretTakedowns,
        meObjDmg: mp.damageToObjectives,
        meDragon: mp.dragonKills,
        meBaron: mp.baronKills,
        meHerald: mp.heraldKills,
        meObjSteals: mp.objectivesStolen,
        meHeal: mp.healOnTeammates,
        meShield: mp.shieldOnTeammates,
        meMissPings: mp.enemyMissingPings,
        opPosition: op.position,
        opChampionId: op.championId,
        opChamp: cOp.champNameEng,
        opKills: op.kills,
        opDeaths: op.deaths,
        opAssists: op.assists,
        opKda: op.kda,
        opDpm: op.dpm,
        opLaneGoldDiff: op.laneGoldDiff,
        opTd15: op.takedownsBefore15Min,
        opPlates: op.turretPlatesDestroyed,
        opExpPerMin: op.expPerMin,
        opDeadPct: op.deadTimePct,
        opJungleCsEnemy: op.jungleCsEnemy,
        opDmg: op.damageToChampions,
        opTaken: op.damageTaken,
        opSelfMit: op.damageSelfMitigated,
        opGold: op.goldEarned,
        opMinions: op.minionsKilled,
        opNeutral: op.neutralMinionsKilled,
        opVision: op.visionScore,
        opWardsP: op.wardsPlaced,
        opWardsK: op.wardsKilled,
        opControlW: op.controlWardsBought,
        opCcTime: op.ccTime,
        opUnderTurretTd: op.takedownsUnderTurret,
        opTurretTd: op.turretTakedowns,
        opObjDmg: op.damageToObjectives,
        opDragon: op.dragonKills,
        opBaron: op.baronKills,
        opHerald: op.heraldKills,
        opObjSteals: op.objectivesStolen,
        opHeal: op.healOnTeammates,
        opShield: op.shieldOnTeammates,
        opMissPings: op.enemyMissingPings,
      })
      .from(mp)
      .innerJoin(op, eq(mp.customMatchId, op.customMatchId))
      .leftJoin(cMp, eq(mp.championId, cMp.id))
      .leftJoin(cOp, eq(op.championId, cOp.id))
      .where(
        and(
          eq(mp.playerCode, mePlayerCode),
          eq(op.playerCode, oppoPlayerCode),
          eq(mp.guildId, guildId),
          ne(mp.gameTeam, op.gameTeam), // 맞붙은(다른 팀)
          eq(mp.isDeleted, false),
          eq(op.isDeleted, false),
          seasonFilter,
        ),
      )
      .orderBy(mp.playedDate);
  }

  /** @desc raw 행 → against 블록 집계 (요약·스트릭·지표·매트릭스·매치업·인사이트·최근) */
  private buildAgainst(
    rows: Awaited<ReturnType<H2hService['queryAgainstRawRows']>>,
    meSeasonAvgKda: number | null,
    recentLimit: number,
    recentOffset: number,
  ): H2hAgainst {
    const games = rows.length;
    const wins = rows.filter((r) => r.meResult === 1).length;
    const losses = games - wins;
    const winRate = games === 0 ? 0 : Math.round((wins / games) * 1000) / 10;

    const streak: ('W' | 'L')[] = rows.map((r) => (r.meResult === 1 ? 'W' : 'L'));
    const seasonBreaks: SeasonBreak[] = [];
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i].meSeason !== rows[i - 1].meSeason) {
        seasonBreaks.push({ index: i, label: rows[i].meSeason });
      }
    }

    const jugRows = rows.filter((r) => r.mePosition === 'JUG' && r.opPosition === 'JUG');
    const mine: H2hMetrics = {
      kda: avg(rows.map((r) => num(r.meKda))),
      dpm: avg(rows.map((r) => num(r.meDpm))),
      laneGoldDiff: avg(rows.map((r) => num(r.meLaneGoldDiff))),
      tdBefore15: avg(rows.map((r) => num(r.meTd15))),
      turretPlates: avg(rows.map((r) => num(r.mePlates))),
      expPerMin: avg(rows.map((r) => num(r.meExpPerMin))),
      deadTimePct: avg(rows.map((r) => num(r.meDeadPct))),
      jungleCsEnemy: jugRows.length ? avg(jugRows.map((r) => num(r.meJungleCsEnemy))) : null,
    };
    const oppos: H2hMetrics = {
      kda: avg(rows.map((r) => num(r.opKda))),
      dpm: avg(rows.map((r) => num(r.opDpm))),
      laneGoldDiff: avg(rows.map((r) => num(r.opLaneGoldDiff))),
      tdBefore15: avg(rows.map((r) => num(r.opTd15))),
      turretPlates: avg(rows.map((r) => num(r.opPlates))),
      expPerMin: avg(rows.map((r) => num(r.opExpPerMin))),
      deadTimePct: avg(rows.map((r) => num(r.opDeadPct))),
      jungleCsEnemy: jugRows.length ? avg(jugRows.map((r) => num(r.opJungleCsEnemy))) : null,
    };

    const matchups = this.buildMatchups(rows, meSeasonAvgKda);
    const laneMatrix = this.buildLaneMatrix(rows);

    return {
      games,
      wins,
      losses,
      winRate,
      streak,
      seasonBreaks,
      mine,
      oppos,
      laneMatrix,
      topLane: H2hService.topSameLane(laneMatrix),
      matchups,
      insights: H2hService.buildInsights(rows, matchups, streak, wins, games),
      recent: this.buildRecent(rows, recentLimit, recentOffset),
      recentTotal: games,
    };
  }

  /** @desc 가장 많이 맞붙은 동일 라인 (laneMatrix 대각선 중 c 최대, 0이면 null) */
  private static topSameLane(laneMatrix: LaneMatrix): LaneTopFaced | null {
    let best: LaneTopFaced | null = null;
    for (const lane of LANES) {
      const cell = laneMatrix[lane]?.[lane];
      if (cell && cell.c > 0 && (!best || cell.c > best.count)) {
        best = { lane, count: cell.c, wins: cell.w };
      }
    }
    return best;
  }

  /** @desc 5×5 라인 매트릭스 (빈 조합도 {c:0,w:0}) */
  private buildLaneMatrix(
    rows: Awaited<ReturnType<H2hService['queryAgainstRawRows']>>,
  ): LaneMatrix {
    const matrix: LaneMatrix = {};
    for (const my of LANES) {
      matrix[my] = {};
      for (const oppo of LANES) matrix[my][oppo] = { c: 0, w: 0 };
    }
    for (const r of rows) {
      const cell = matrix[r.mePosition]?.[r.opPosition];
      if (!cell) continue; // 비정상 position 제외
      cell.c += 1;
      if (r.meResult === 1) cell.w += 1;
    }
    return matrix;
  }

  /** @desc 챔피언 매치업 (champion_id NULL 제외, count DESC) */
  private buildMatchups(
    rows: Awaited<ReturnType<H2hService['queryAgainstRawRows']>>,
    meSeasonAvgKda: number | null,
  ): H2hMatchup[] {
    interface Acc {
      myLane: string;
      oppoLane: string;
      myChamp: string;
      oppoChamp: string;
      count: number;
      wins: number;
      kdaSum: number;
      kdaCount: number;
    }
    const map = new Map<string, Acc>();
    for (const r of rows) {
      if (!r.meChampionId || !r.opChampionId) continue;
      const key = `${r.meChampionId}|${r.opChampionId}|${r.mePosition}|${r.opPosition}`;
      const acc = map.get(key) ?? {
        myLane: r.mePosition,
        oppoLane: r.opPosition,
        myChamp: r.meChamp ?? r.meChampionId,
        oppoChamp: r.opChamp ?? r.opChampionId,
        count: 0,
        wins: 0,
        kdaSum: 0,
        kdaCount: 0,
      };
      acc.count += 1;
      if (r.meResult === 1) acc.wins += 1;
      const k = num(r.meKda);
      if (k !== null) {
        acc.kdaSum += k;
        acc.kdaCount += 1;
      }
      map.set(key, acc);
    }

    return Array.from(map.values())
      .sort((a, b) => b.count - a.count)
      .map((a) => {
        const myKda = a.kdaCount === 0 ? 0 : Math.round((a.kdaSum / a.kdaCount) * 100) / 100;
        const diff = meSeasonAvgKda === null ? 0 : Math.round((myKda - meSeasonAvgKda) * 100) / 100;
        return {
          myLane: a.myLane,
          oppoLane: a.oppoLane,
          myChamp: a.myChamp,
          oppoChamp: a.oppoChamp,
          count: a.count,
          wins: a.wins,
          myKda: String(myKda),
          kdaDiff: `${diff >= 0 ? '+' : ''}${diff}`,
        };
      });
  }

  /** @desc 최근 맞대결 (최신순 + 페이지네이션). 맞라인 게임만 detail 포함 */
  private buildRecent(
    rows: Awaited<ReturnType<H2hService['queryAgainstRawRows']>>,
    limit: number,
    offset: number,
  ): H2hRecentItem[] {
    const sorted = [...rows].sort((a, b) => b.mePlayedDate.getTime() - a.mePlayedDate.getTime());
    return sorted.slice(offset, offset + limit).map((r) => {
      const item: H2hRecentItem = {
        matchId: r.meCustomMatchId,
        playedDate: r.mePlayedDate,
        myResult: r.meResult === 1 ? 'W' : 'L',
        myLane: r.mePosition,
        oppoLane: r.opPosition,
        myChamp: r.meChamp ?? r.meChampionId ?? '',
        oppoChamp: r.opChamp ?? r.opChampionId ?? '',
        myKda: `${r.meKills ?? 0}/${r.meDeaths ?? 0}/${r.meAssists ?? 0}`,
        oppoKda: `${r.opKills ?? 0}/${r.opDeaths ?? 0}/${r.opAssists ?? 0}`,
        gameLen: r.meGameLen ?? 0,
      };
      // 맞라인(같은 position) 게임만 세부 보기 제공
      if (r.mePosition === r.opPosition) {
        item.detail = {
          mine: H2hService.recentDetailSide('me', r),
          oppo: H2hService.recentDetailSide('op', r),
        };
      }
      return item;
    });
  }

  /** @desc 함께한(같은 팀) 게임 raw 한 쌍씩 (지표·detail 불필요해 컬럼 최소화) */
  private async queryTogetherRawRows(
    guildId: string,
    mePlayerCode: string,
    oppoPlayerCode: string,
    season: string | null,
  ) {
    const mp = alias(mmrParticipantMetric, 'mp_wg');
    const op = alias(mmrParticipantMetric, 'op_wg');
    const cMp = alias(champion, 'champ_mp_wg');
    const cOp = alias(champion, 'champ_op_wg');
    const seasonFilter = season === null ? undefined : eq(mp.season, season);

    return db
      .select({
        meCustomMatchId: mp.customMatchId,
        mePlayedDate: mp.playedDate,
        meResult: mp.gameResult,
        mePosition: mp.position,
        meChampionId: mp.championId,
        meChamp: cMp.champNameEng,
        meKills: mp.kills,
        meDeaths: mp.deaths,
        meAssists: mp.assists,
        meGameLen: mp.gameDuration,
        opPosition: op.position,
        opChampionId: op.championId,
        opChamp: cOp.champNameEng,
        opKills: op.kills,
        opDeaths: op.deaths,
        opAssists: op.assists,
      })
      .from(mp)
      .innerJoin(op, eq(mp.customMatchId, op.customMatchId))
      .leftJoin(cMp, eq(mp.championId, cMp.id))
      .leftJoin(cOp, eq(op.championId, cOp.id))
      .where(
        and(
          eq(mp.playerCode, mePlayerCode),
          eq(op.playerCode, oppoPlayerCode),
          eq(mp.guildId, guildId),
          eq(mp.gameTeam, op.gameTeam), // 함께한(같은 팀)
          eq(mp.isDeleted, false),
          eq(op.isDeleted, false),
          seasonFilter,
        ),
      )
      .orderBy(mp.playedDate);
  }

  /** @desc raw 행 → together 블록 (지표·매트릭스·인사이트 없음) */
  private buildTogether(
    rows: Awaited<ReturnType<H2hService['queryTogetherRawRows']>>,
  ): H2hTogether {
    const games = rows.length;
    const wins = rows.filter((r) => r.meResult === 1).length;
    const losses = games - wins;
    const winRate = games === 0 ? 0 : Math.round((wins / games) * 1000) / 10;
    const streak: ('W' | 'L')[] = rows.map((r) => (r.meResult === 1 ? 'W' : 'L'));

    // 라인 조합 분포
    const comboMap = new Map<string, H2hLaneCombo>();
    for (const r of rows) {
      const key = `${r.mePosition}|${r.opPosition}`;
      const c = comboMap.get(key) ?? {
        mine: r.mePosition,
        oppo: r.opPosition,
        count: 0,
        wins: 0,
      };
      c.count += 1;
      if (r.meResult === 1) c.wins += 1;
      comboMap.set(key, c);
    }
    const laneCombos = Array.from(comboMap.values()).sort((a, b) => b.count - a.count);

    // 자주 가는 듀오 픽 (champion_id NULL 제외)
    interface DuoAcc {
      mine: string;
      oppo: string;
      mineLane: string;
      oppoLane: string;
      count: number;
      wins: number;
      ka: number; // 두 사람 K+A 합
      d: number; // 두 사람 D 합
    }
    const duoMap = new Map<string, DuoAcc>();
    for (const r of rows) {
      if (!r.meChampionId || !r.opChampionId) continue;
      const key = `${r.meChampionId}|${r.opChampionId}`;
      const acc = duoMap.get(key) ?? {
        mine: r.meChamp ?? r.meChampionId,
        oppo: r.opChamp ?? r.opChampionId,
        mineLane: r.mePosition,
        oppoLane: r.opPosition,
        count: 0,
        wins: 0,
        ka: 0,
        d: 0,
      };
      acc.count += 1;
      if (r.meResult === 1) acc.wins += 1;
      acc.ka += (r.meKills ?? 0) + (r.meAssists ?? 0) + (r.opKills ?? 0) + (r.opAssists ?? 0);
      acc.d += (r.meDeaths ?? 0) + (r.opDeaths ?? 0);
      duoMap.set(key, acc);
    }
    const duoChamps: H2hDuoChamp[] = Array.from(duoMap.values())
      .sort((a, b) => b.count - a.count)
      .map((a) => ({
        mine: a.mine,
        oppo: a.oppo,
        mineLane: a.mineLane,
        oppoLane: a.oppoLane,
        count: a.count,
        wins: a.wins,
        comboKda: String(Math.round((a.ka / (a.d === 0 ? 1 : a.d)) * 100) / 100),
      }));

    // 최근 함께한 8건 (detail 없음)
    const recent: H2hRecentItem[] = [...rows]
      .sort((a, b) => b.mePlayedDate.getTime() - a.mePlayedDate.getTime())
      .slice(0, 8)
      .map((r) => ({
        matchId: r.meCustomMatchId,
        playedDate: r.mePlayedDate,
        myResult: r.meResult === 1 ? 'W' : 'L',
        myLane: r.mePosition,
        oppoLane: r.opPosition,
        myChamp: r.meChamp ?? r.meChampionId ?? '',
        oppoChamp: r.opChamp ?? r.opChampionId ?? '',
        myKda: `${r.meKills ?? 0}/${r.meDeaths ?? 0}/${r.meAssists ?? 0}`,
        oppoKda: `${r.opKills ?? 0}/${r.opDeaths ?? 0}/${r.opAssists ?? 0}`,
        gameLen: r.meGameLen ?? 0,
      }));

    return {
      games,
      wins,
      losses,
      winRate,
      streak,
      laneCombos,
      topLaneCombo: laneCombos[0] ?? null, // 가장 많이 함께한 라인 조합
      duoChamps,
      recent,
    };
  }

  /**
   * @desc 인사이트 카드 A1~A5 (최대 4장, 우선순위순). 챔프는 영문 키 → 프론트가 한글 변환.
   */
  private static buildInsights(
    rows: Awaited<ReturnType<H2hService['queryAgainstRawRows']>>,
    matchups: H2hMatchup[],
    streak: ('W' | 'L')[],
    wins: number,
    games: number,
  ): H2hInsight[] {
    const insights: H2hInsight[] = [];

    const withWr = matchups.map((m) => ({
      ...m,
      wr: m.count === 0 ? 0 : Math.round((m.wins / m.count) * 1000) / 10,
      losses: m.count - m.wins,
      kdaDiffNum: parseFloat(m.kdaDiff) || 0,
    }));

    // A1 필승 카드 — count≥2 AND 승률≥60% (승률 → kdaDiff → count)
    const bestCands = withWr.filter((m) => m.count >= 2 && m.wr >= 60);
    if (bestCands.length) {
      const best = [...bestCands].sort(
        (a, b) => b.wr - a.wr || b.kdaDiffNum - a.kdaDiffNum || b.count - a.count,
      )[0];
      insights.push({
        kind: 'best',
        type: 'counterPick',
        myChamp: best.myChamp,
        oppoChamp: best.oppoChamp,
        wins: best.wins,
        losses: best.losses,
        winRate: best.wr,
        kdaDiff: best.kdaDiffNum,
      });
    }

    // A2 천적 주의보 — count≥2 AND 승률≤40% (승률 → kdaDiff 낮은 쪽)
    const worstCands = withWr.filter((m) => m.count >= 2 && m.wr <= 40);
    if (worstCands.length) {
      const worst = [...worstCands].sort((a, b) => a.wr - b.wr || a.kdaDiffNum - b.kdaDiffNum)[0];
      insights.push({
        kind: 'worst',
        type: 'nemesis',
        myChamp: worst.myChamp,
        oppoChamp: worst.oppoChamp,
        wins: worst.wins,
        losses: worst.losses,
        winRate: worst.wr,
        kdaDiff: worst.kdaDiffNum,
      });
    }

    // A3 라인전-결과 괴리 — 패배 중 라인골드 우위 / (반대) 승리 중 라인골드 열세
    const lossRows = rows.filter((r) => r.meResult === 0);
    const winRows = rows.filter((r) => r.meResult === 1);
    const goldAdvLosses = lossRows.filter((r) => (num(r.meLaneGoldDiff) ?? 0) > 0).length;
    const goldDisadvWins = winRows.filter((r) => (num(r.meLaneGoldDiff) ?? 0) < 0).length;
    if (lossRows.length >= 3 && goldAdvLosses / lossRows.length >= 0.5) {
      insights.push({
        kind: 'counter',
        type: 'laneVsResult',
        direction: 'laneWinButLose',
        total: lossRows.length, // 패배 수
        laneCount: goldAdvLosses, // 그중 라인 골드 우위
      });
    } else if (winRows.length >= 3 && goldDisadvWins / winRows.length >= 0.5) {
      insights.push({
        kind: 'best',
        type: 'laneVsResult',
        direction: 'laneLoseButWin',
        total: winRows.length, // 승리 수
        laneCount: goldDisadvWins, // 그중 라인 골드 열세
      });
    }

    // A4 요즘 기세 — 맞대결≥8 AND 통산 vs 최근5판 승률차 ≥ ±20%p
    if (games >= 8) {
      const careerWinRate = Math.round((wins / games) * 1000) / 10;
      const last5 = streak.slice(-5);
      const recentWins = last5.filter((s) => s === 'W').length;
      const recentWinRate = Math.round((recentWins / last5.length) * 1000) / 10;
      if (Math.abs(recentWinRate - careerWinRate) >= 20) {
        insights.push({
          kind: 'info',
          type: 'momentum',
          direction: recentWinRate > careerWinRate ? 'up' : 'down',
          recentN: last5.length,
          recentWins,
          recentWinRate,
          careerWinRate,
        });
      }
    }

    // A5 역대 기록 — A1~A4로 4장이 안 찼을 때만 (최장 연승/연패 ≥ 3)
    if (insights.length < 4) {
      const longest = H2hService.longestStreak(streak);
      if (longest.len >= 3) {
        const curr = H2hService.currentStreak(streak);
        insights.push({
          kind: longest.kind === 'W' ? 'best' : 'worst',
          type: 'streak',
          streakKind: longest.kind === 'W' ? 'win' : 'lose',
          length: longest.len,
          fromDate: rows[longest.startIdx]?.mePlayedDate ?? null,
          toDate: rows[longest.endIdx]?.mePlayedDate ?? null,
          currentLength: curr.len,
        });
      }
    }

    return insights.slice(0, 4);
  }

  /** @desc 최장 연승/연패 구간 (streak 배열 인덱스 포함, fromDate/toDate 추출용) */
  private static longestStreak(streak: ('W' | 'L')[]): {
    kind: 'W' | 'L';
    len: number;
    startIdx: number;
    endIdx: number;
  } {
    let bestKind: 'W' | 'L' = 'W';
    let bestLen = 0;
    let bestStart = 0;
    let curKind: 'W' | 'L' | null = null;
    let curLen = 0;
    let curStart = 0;
    for (let i = 0; i < streak.length; i += 1) {
      const s = streak[i];
      if (s === curKind) {
        curLen += 1;
      } else {
        curKind = s;
        curLen = 1;
        curStart = i;
      }
      if (curLen > bestLen) {
        bestLen = curLen;
        bestKind = s;
        bestStart = curStart;
      }
    }
    return { kind: bestKind, len: bestLen, startIdx: bestStart, endIdx: bestStart + bestLen - 1 };
  }

  /** @desc 현재(최신) 진행 중인 연승/연패 */
  private static currentStreak(streak: ('W' | 'L')[]): { kind: 'W' | 'L'; len: number } {
    if (streak.length === 0) return { kind: 'W', len: 0 };
    const kind = streak[streak.length - 1];
    let len = 0;
    for (let i = streak.length - 1; i >= 0 && streak[i] === kind; i -= 1) len += 1;
    return { kind, len };
  }

  /** @desc recent detail 한쪽 raw 지표 묶음. NULL은 0으로 (프론트 숫자 가정) */
  private static recentDetailSide(
    side: 'me' | 'op',
    r: Awaited<ReturnType<H2hService['queryAgainstRawRows']>>[number],
  ): H2hRecentDetailSide {
    const me = side === 'me';
    const pick = (a: number | null, b: number | null): number => (me ? a : b) ?? 0;
    const z = (v: number | null): number => v ?? 0;
    return {
      dmg: pick(r.meDmg, r.opDmg),
      taken: pick(r.meTaken, r.opTaken),
      selfMit: pick(r.meSelfMit, r.opSelfMit),
      gold: pick(r.meGold, r.opGold),
      cs: pick(r.meMinions, r.opMinions) + pick(r.meNeutral, r.opNeutral),
      vision: pick(r.meVision, r.opVision),
      wardsP: pick(r.meWardsP, r.opWardsP),
      wardsK: pick(r.meWardsK, r.opWardsK),
      controlW: pick(r.meControlW, r.opControlW),
      ccTime: pick(r.meCcTime, r.opCcTime),
      kda: z(num(me ? r.meKda : r.opKda)),
      td15: pick(r.meTd15, r.opTd15),
      underTurretTd: pick(r.meUnderTurretTd, r.opUnderTurretTd),
      turretTd: pick(r.meTurretTd, r.opTurretTd),
      plates: pick(r.mePlates, r.opPlates),
      enemyJungleCs: pick(r.meJungleCsEnemy, r.opJungleCsEnemy),
      objDmg: pick(r.meObjDmg, r.opObjDmg),
      epicKills:
        pick(r.meDragon, r.opDragon) + pick(r.meBaron, r.opBaron) + pick(r.meHerald, r.opHerald),
      objSteals: pick(r.meObjSteals, r.opObjSteals),
      deadPct: z(num(me ? r.meDeadPct : r.opDeadPct)),
      healShield: pick(r.meHeal, r.opHeal) + pick(r.meShield, r.opShield),
      missPings: pick(r.meMissPings, r.opMissPings),
      laneGoldDiff: z(num(me ? r.meLaneGoldDiff : r.opLaneGoldDiff)),
    };
  }
}

export const h2hService = new H2hService();
