import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../database/connectionPool.js';
import {
  matchParticipant,
  customMatch,
  champion,
  riotAccount,
  guildMember,
} from '../database/schema.js';
import {
  EncounterRawGame,
  EncounterPlayer,
  EncounterScenario,
  EncounterKda,
  EncounterAvgMetrics,
  EncounterChampion,
  LaneMatrixCell,
  EncounterInsight,
  EncounterSummary,
  EncounterGameItem,
  EncounterGamesResult,
  ChampionMatchup,
  DuoPick,
  FrequentOpponent,
  FrequentOpponentsResult,
  FrequentOpponentsQuery,
} from '../types/encounter.js';

export class EncounterService {
  private readonly MIN_MATCHUP_GAMES = 3;

  // ──────────────────────────────────────────────
  // Step 2: DB 쿼리
  // ──────────────────────────────────────────────

  /**
   * @desc 두 플레이어가 함께한 모든 게임 raw 조회 (셀프 조인)
   * aTeam === bTeam → 아군 / aTeam !== bTeam → 적
   */
  public async getEncounterRawGames(
    playerCode1: string,
    playerCode2: string,
    guildId: string,
    season: string,
  ): Promise<EncounterRawGame[]> {
    const mpA = alias(matchParticipant, 'mp_a');
    const mpB = alias(matchParticipant, 'mp_b');
    const champA = alias(champion, 'champ_a');
    const champB = alias(champion, 'champ_b');

    return db
      .select({
        customMatchId: mpA.customMatchId,
        createDate: customMatch.createDate,
        timePlayed: mpA.timePlayed,

        aTeam: mpA.gameTeam,
        aResult: mpA.gameResult,
        aPosition: mpA.position,
        aChampName: champA.champName,
        aChampNameEng: champA.champNameEng,
        aKill: mpA.kill,
        aDeath: mpA.death,
        aAssist: mpA.assist,
        aDamage: mpA.totalDamageChampions,
        aCs: sql<number>`(COALESCE(${mpA.minionsKilled}, 0) + COALESCE(${mpA.neutralMinionsKilled}, 0))`,
        aGold: mpA.gold,
        aVision: mpA.visionScore,

        bTeam: mpB.gameTeam,
        bResult: mpB.gameResult,
        bPosition: mpB.position,
        bChampName: champB.champName,
        bChampNameEng: champB.champNameEng,
        bKill: mpB.kill,
        bDeath: mpB.death,
        bAssist: mpB.assist,
        bDamage: mpB.totalDamageChampions,
        bCs: sql<number>`(COALESCE(${mpB.minionsKilled}, 0) + COALESCE(${mpB.neutralMinionsKilled}, 0))`,
        bGold: mpB.gold,
        bVision: mpB.visionScore,
      })
      .from(mpA)
      .innerJoin(mpB, eq(mpA.customMatchId, mpB.customMatchId))
      .innerJoin(customMatch, eq(mpA.customMatchId, customMatch.id))
      .innerJoin(champA, eq(mpA.championId, champA.id))
      .innerJoin(champB, eq(mpB.championId, champB.id))
      .where(
        and(
          eq(mpA.playerCode, playerCode1),
          eq(mpB.playerCode, playerCode2),
          eq(customMatch.guildId, guildId),
          eq(customMatch.season, season),
          eq(mpA.isDeleted, false),
          eq(mpB.isDeleted, false),
          eq(customMatch.isDeleted, false),
        ),
      )
      .orderBy(desc(customMatch.createDate));
  }

  /**
   * @desc 자주 만난 상대 목록 조회
   * period: recent(최근 2개월) | all(전체)
   * season: 특정 시즌 필터 — period와 AND 조건으로 동시 적용 가능
   * sortBy: totalGames(판수순) | winRate(승률순)
   */
  public async getFrequentOpponents(
    playerCode: string,
    guildId: string,
    query: FrequentOpponentsQuery,
  ): Promise<FrequentOpponentsResult> {
    const { period = 'recent', sortBy = 'totalGames', page = '1', limit = '20', season } = query;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const offset = (pageNum - 1) * limitNum;

    const mpMe = alias(matchParticipant, 'mp_me');
    const mpOther = alias(matchParticipant, 'mp_other');

    const totalGamesExpr = sql<number>`COUNT(*)::integer`;
    const allyGamesExpr = sql<number>`COUNT(CASE WHEN ${mpMe.gameTeam} = ${mpOther.gameTeam} THEN 1 END)::integer`;
    const allyWinExpr = sql<number>`COUNT(CASE WHEN ${mpMe.gameTeam} = ${mpOther.gameTeam} AND ${mpMe.gameResult} = '승' THEN 1 END)::integer`;
    const enemyGamesExpr = sql<number>`COUNT(CASE WHEN ${mpMe.gameTeam} != ${mpOther.gameTeam} THEN 1 END)::integer`;
    const enemyWinExpr = sql<number>`COUNT(CASE WHEN ${mpMe.gameTeam} != ${mpOther.gameTeam} AND ${mpMe.gameResult} = '승' THEN 1 END)::integer`;
    const winRateExpr = sql<number>`
      CASE WHEN COUNT(*) = 0 THEN 0
      ELSE ROUND(
        (COUNT(CASE WHEN ${mpMe.gameResult} = '승' THEN 1 END)::numeric * 100.0) / COUNT(*),
        2
      ) END`;

    const periodCondition =
      period === 'recent'
        ? sql`${customMatch.createDate} >= NOW() - INTERVAL '2 months'`
        : undefined;

    const seasonCondition = season ? eq(customMatch.season, season) : undefined;

    const orderExpr = sortBy === 'winRate' ? desc(winRateExpr) : desc(totalGamesExpr);

    const baseCondition = and(
      eq(mpMe.playerCode, playerCode),
      eq(customMatch.guildId, guildId),
      eq(guildMember.guildId, guildId),
      eq(guildMember.isMain, true),
      eq(guildMember.status, '1'),
      eq(guildMember.isDeleted, false),
      eq(mpMe.isDeleted, false),
      eq(mpOther.isDeleted, false),
      eq(customMatch.isDeleted, false),
      periodCondition,
      seasonCondition,
    );

    const rows = await db
      .select({
        playerCode: riotAccount.playerCode,
        riotName: riotAccount.riotName,
        riotNameTag: riotAccount.riotNameTag,
        totalGames: totalGamesExpr,
        allyGames: allyGamesExpr,
        allyWin: allyWinExpr,
        enemyGames: enemyGamesExpr,
        enemyWin: enemyWinExpr,
      })
      .from(mpMe)
      .innerJoin(
        mpOther,
        and(eq(mpMe.customMatchId, mpOther.customMatchId), ne(mpOther.playerCode, playerCode)),
      )
      .innerJoin(riotAccount, eq(mpOther.playerCode, riotAccount.playerCode))
      .innerJoin(guildMember, eq(mpOther.playerCode, guildMember.account))
      .innerJoin(customMatch, eq(mpMe.customMatchId, customMatch.id))
      .where(baseCondition)
      .groupBy(riotAccount.playerCode, riotAccount.riotName, riotAccount.riotNameTag)
      .orderBy(orderExpr)
      .limit(limitNum)
      .offset(offset);

    const [countResult] = await db
      .select({ count: sql<number>`COUNT(DISTINCT ${mpOther.playerCode})::integer` })
      .from(mpMe)
      .innerJoin(
        mpOther,
        and(eq(mpMe.customMatchId, mpOther.customMatchId), ne(mpOther.playerCode, playerCode)),
      )
      .innerJoin(riotAccount, eq(mpOther.playerCode, riotAccount.playerCode))
      .innerJoin(guildMember, eq(mpOther.playerCode, guildMember.account))
      .innerJoin(customMatch, eq(mpMe.customMatchId, customMatch.id))
      .where(baseCondition);

    const opponents: FrequentOpponent[] = rows.map((r) => ({
      playerCode: r.playerCode,
      riotName: r.riotName,
      riotNameTag: r.riotNameTag,
      totalGames: r.totalGames,
      asAllies: {
        total: r.allyGames,
        win: r.allyWin,
        lose: r.allyGames - r.allyWin,
      },
      asEnemies: {
        total: r.enemyGames,
        win: r.enemyWin,
        lose: r.enemyGames - r.enemyWin,
      },
    }));

    return { opponents, totalCount: countResult?.count ?? 0 };
  }

  // ──────────────────────────────────────────────
  // Step 3: TS 집계
  // ──────────────────────────────────────────────

  /**
   * @desc raw 게임 목록으로 summary 전체 집계
   */
  public buildEncounterSummary(
    rawGames: EncounterRawGame[],
    playerA: EncounterPlayer,
    playerB: EncounterPlayer,
    matchupPosition: string = 'ALL',
  ): EncounterSummary {
    if (rawGames.length === 0) {
      return this.emptyEncounterSummary(playerA, playerB);
    }

    const enemyGames = rawGames.filter((g) => g.aTeam !== g.bTeam);
    const allyGames = rawGames.filter((g) => g.aTeam === g.bTeam);

    const countWins = (games: EncounterRawGame[]) =>
      games.filter((g) => g.aResult === '승').length;

    const toScenario = (games: EncounterRawGame[]): EncounterScenario => {
      const win = countWins(games);
      return { total: games.length, win, lose: games.length - win };
    };

    const avgGameTimeSec = Math.round(
      rawGames.reduce((sum, g) => sum + g.timePlayed, 0) / rawGames.length,
    );

    const laneMatrix = this.calcLaneMatrix(enemyGames);
    const allyLaneMatrix = this.calcLaneMatrix(allyGames);
    const allChampionMatchups = this.calcChampionMatchups(enemyGames, matchupPosition);
    const allDuoPicks = this.calcDuoPicks(allyGames);

    return {
      playerA,
      playerB,
      overall: toScenario(rawGames),
      asEnemies: toScenario(enemyGames),
      asAllies: toScenario(allyGames),
      avgGameTimeSec,
      kda: {
        playerA: this.calcKda(rawGames, 'aKill', 'aDeath', 'aAssist'),
        playerB: this.calcKda(rawGames, 'bKill', 'bDeath', 'bAssist'),
      },
      avgMetrics: {
        playerA: this.calcAvgMetrics(rawGames, 'aDamage', 'aCs', 'aGold', 'aVision'),
        playerB: this.calcAvgMetrics(rawGames, 'bDamage', 'bCs', 'bGold', 'bVision'),
      },
      topChampions: {
        playerA: this.calcTopChampions(rawGames, 'aChampName', 'aChampNameEng', 'aResult'),
        playerB: this.calcTopChampions(rawGames, 'bChampName', 'bChampNameEng', 'bResult'),
      },
      laneMatrix,
      allyLaneMatrix,
      championMatchups: allChampionMatchups.slice(0, 5),
      duoPicks: allDuoPicks.slice(0, 5),
      insights: this.calcInsights(laneMatrix, allyLaneMatrix, allChampionMatchups, allDuoPicks),
    };
  }

  /**
   * @desc 경기 기록 탭용 게임 목록 (scenario 필터 + 페이지네이션)
   */
  public getEncounterGames(
    rawGames: EncounterRawGame[],
    scenario: 'all' | 'enemies' | 'allies' = 'all',
    page = 1,
    limit = 20,
  ): EncounterGamesResult {
    const filtered = rawGames.filter((g) => {
      const isAlly = g.aTeam === g.bTeam;
      if (scenario === 'allies') return isAlly;
      if (scenario === 'enemies') return !isAlly;
      return true;
    });

    const totalCount = filtered.length;
    const games: EncounterGameItem[] = filtered
      .slice((page - 1) * limit, page * limit)
      .map((g) => ({
        customMatchId: g.customMatchId,
        createDate: g.createDate,
        isAlly: g.aTeam === g.bTeam,
        playerAWon: g.aResult === '승',
        timePlayed: g.timePlayed,
        playerA: {
          position: g.aPosition,
          champName: g.aChampName,
          champNameEng: g.aChampNameEng,
          kill: g.aKill,
          death: g.aDeath,
          assist: g.aAssist,
        },
        playerB: {
          position: g.bPosition,
          champName: g.bChampName,
          champNameEng: g.bChampNameEng,
          kill: g.bKill,
          death: g.bDeath,
          assist: g.bAssist,
        },
      }));

    return { games, totalCount };
  }

  // ── Private helpers ──

  /**
   * @desc 평균 K/D/A 및 KDA 비율 계산
   * death가 0이면 KDA를 9999로 처리 (Perfect KDA)
   */
  private calcKda(
    games: EncounterRawGame[],
    killKey: 'aKill' | 'bKill',
    deathKey: 'aDeath' | 'bDeath',
    assistKey: 'aAssist' | 'bAssist',
  ): EncounterKda {
    const n = games.length;
    const totalKill = games.reduce((s, g) => s + g[killKey], 0);
    const totalDeath = games.reduce((s, g) => s + g[deathKey], 0);
    const totalAssist = games.reduce((s, g) => s + g[assistKey], 0);
    const kda =
      totalDeath === 0 ? 9999 : Math.round(((totalKill + totalAssist) / totalDeath) * 100) / 100;
    return {
      avgKill: Math.round((totalKill / n) * 10) / 10,
      avgDeath: Math.round((totalDeath / n) * 10) / 10,
      avgAssist: Math.round((totalAssist / n) * 10) / 10,
      kda,
    };
  }

  /**
   * @desc 평균 지표 계산 (데미지, CS/분, 골드/분, 시야)
   * CS/분·골드/분은 게임별 분당으로 나누지 않고 전체 합산 기준으로 계산해 이상치 희석
   */
  private calcAvgMetrics(
    games: EncounterRawGame[],
    damageKey: 'aDamage' | 'bDamage',
    csKey: 'aCs' | 'bCs',
    goldKey: 'aGold' | 'bGold',
    visionKey: 'aVision' | 'bVision',
  ): EncounterAvgMetrics {
    const n = games.length;
    const totalDamage = games.reduce((s, g) => s + g[damageKey], 0);
    const totalCs = games.reduce((s, g) => s + g[csKey], 0);
    const totalGold = games.reduce((s, g) => s + g[goldKey], 0);
    const totalVision = games.reduce((s, g) => s + g[visionKey], 0);
    const totalMinutes = games.reduce((s, g) => s + g.timePlayed / 60, 0);
    return {
      avgDamage: Math.round(totalDamage / n),
      avgCsPerMin: Math.round((totalCs / totalMinutes) * 10) / 10,
      avgGoldPerMin: Math.round((totalGold / totalMinutes) * 10) / 10,
      avgVision: Math.round((totalVision / n) * 10) / 10,
    };
  }

  /**
   * @desc 챔피언별 판수·승률 집계 후 판수 내림차순 상위 3개 반환
   */
  private calcTopChampions(
    games: EncounterRawGame[],
    nameKey: 'aChampName' | 'bChampName',
    nameEngKey: 'aChampNameEng' | 'bChampNameEng',
    resultKey: 'aResult' | 'bResult',
  ): EncounterChampion[] {
    const map = new Map<string, { champName: string; champNameEng: string; games: number; win: number }>();
    for (const g of games) {
      const name = g[nameKey];
      const entry = map.get(name) ?? { champName: name, champNameEng: g[nameEngKey], games: 0, win: 0 };
      entry.games++;
      if (g[resultKey] === '승') entry.win++;
      map.set(name, entry);
    }
    return Array.from(map.values())
      .sort((a, b) => b.games - a.games)
      .slice(0, 3)
      .map((c) => ({ ...c, winRate: Math.round((c.win / c.games) * 1000) / 10 }));
  }

  /**
   * @desc 포지션 조합별 승률 행렬 계산 (적/아군 공통)
   * key: "{aPosition}|{bPosition}" 형태로 그룹핑
   */
  private calcLaneMatrix(games: EncounterRawGame[]): LaneMatrixCell[] {
    const map = new Map<string, { aWin: number; total: number }>();
    for (const g of games) {
      const key = `${g.aPosition}|${g.bPosition}`;
      const entry = map.get(key) ?? { aWin: 0, total: 0 };
      entry.total++;
      if (g.aResult === '승') entry.aWin++;
      map.set(key, entry);
    }
    return Array.from(map.entries()).map(([key, val]) => {
      const [aPosition, bPosition] = key.split('|');
      return {
        aPosition,
        bPosition,
        total: val.total,
        aWin: val.aWin,
        aWinRate: Math.round((val.aWin / val.total) * 1000) / 10,
      };
    });
  }

  /**
   * @desc 인사이트 5종 계산
   * 3판 이상 전체 조합 기준 (display용 top5 슬라이스 전 데이터 사용)
   */
  private calcInsights(
    laneMatrix: LaneMatrixCell[],
    allyLaneMatrix: LaneMatrixCell[],
    championMatchups: ChampionMatchup[],
    duoPicks: DuoPick[],
  ): EncounterInsight[] {
    const insights: EncounterInsight[] = [];

    // 적 챔피언 쌍: 승률 내림차순 (3판 이상 전체 기준)
    const pairs = [...championMatchups].sort((a, b) => b.winRate - a.winRate);

    if (pairs.length > 0) {
      const best = pairs[0];
      insights.push({
        type: 'bestMatchup',
        aChampName: best.aChampName,
        aChampNameEng: best.aChampNameEng,
        bChampName: best.bChampName,
        bChampNameEng: best.bChampNameEng,
        aWin: best.win,
        total: best.total,
        aWinRate: best.winRate,
      });

      // 챔피언 쌍이 2개 이상일 때만 worstMatchup 추가 (1개면 best === worst)
      if (pairs.length > 1) {
        const worst = pairs[pairs.length - 1];
        insights.push({
          type: 'worstMatchup',
          aChampName: worst.aChampName,
          aChampNameEng: worst.aChampNameEng,
          bChampName: worst.bChampName,
          bChampNameEng: worst.bChampNameEng,
          aWin: worst.win,
          total: worst.total,
          aWinRate: worst.winRate,
        });
      }
    }

    // 가장 강한 라인 (3판 이상만, 동점 시 판수 우선)
    const qualifiedLanes = laneMatrix.filter((cell) => cell.total >= this.MIN_MATCHUP_GAMES);
    if (qualifiedLanes.length > 0) {
      const strongest = [...qualifiedLanes].sort(
        (a, b) => b.aWinRate - a.aWinRate || b.total - a.total,
      )[0];
      insights.push({
        type: 'strongestLane',
        aPosition: strongest.aPosition,
        bPosition: strongest.bPosition,
        aWin: strongest.aWin,
        total: strongest.total,
        aWinRate: strongest.aWinRate,
      });
    }

    // 아군 베스트 챔피언 조합: 승률 내림차순 (3판 이상 전체 기준)
    const sortedDuoPicks = [...duoPicks].sort((a, b) => b.winRate - a.winRate || b.total - a.total);
    if (sortedDuoPicks.length > 0) {
      const best = sortedDuoPicks[0];
      insights.push({
        type: 'bestAllyMatchup',
        aChampName: best.aChampName,
        aChampNameEng: best.aChampNameEng,
        bChampName: best.bChampName,
        bChampNameEng: best.bChampNameEng,
        aWin: best.win,
        total: best.total,
        aWinRate: best.winRate,
      });
    }

    // 아군 베스트 라인 조합 (3판 이상만, 동점 시 판수 우선)
    const qualifiedAllyLanes = allyLaneMatrix.filter((cell) => cell.total >= this.MIN_MATCHUP_GAMES);
    if (qualifiedAllyLanes.length > 0) {
      const bestAlly = [...qualifiedAllyLanes].sort(
        (a, b) => b.aWinRate - a.aWinRate || b.total - a.total,
      )[0];
      insights.push({
        type: 'bestAllyLane',
        aPosition: bestAlly.aPosition,
        bPosition: bestAlly.bPosition,
        aWin: bestAlly.aWin,
        total: bestAlly.total,
        aWinRate: bestAlly.aWinRate,
      });
    }

    return insights;
  }

  /**
   * @desc 적으로 만난 게임의 챔피언 조합별 판수/KDA/승률 집계 (판수 내림차순)
   * position='ALL': 포지션 무관 챔프 조합으로 집계
   * position='ADC' 등: 해당 포지션 게임만 필터 후 집계
   * KDA는 누적 합산 기준으로 계산해 이상치 희석
   */
  private calcChampionMatchups(enemyGames: EncounterRawGame[], position: string = 'ALL'): ChampionMatchup[] {
    const games = position === 'ALL' ? enemyGames : enemyGames.filter((g) => g.aPosition === position);

    const map = new Map<
      string,
      {
        aChampName: string;
        aChampNameEng: string;
        bChampName: string;
        bChampNameEng: string;
        total: number;
        win: number;
        aKill: number;
        aDeath: number;
        aAssist: number;
        bKill: number;
        bDeath: number;
        bAssist: number;
      }
    >();

    for (const g of games) {
      const key = `${g.aChampName}|${g.bChampName}`;
      const entry = map.get(key) ?? {
        aChampName: g.aChampName,
        aChampNameEng: g.aChampNameEng,
        bChampName: g.bChampName,
        bChampNameEng: g.bChampNameEng,
        total: 0,
        win: 0,
        aKill: 0,
        aDeath: 0,
        aAssist: 0,
        bKill: 0,
        bDeath: 0,
        bAssist: 0,
      };
      entry.total++;
      if (g.aResult === '승') entry.win++;
      entry.aKill += g.aKill;
      entry.aDeath += g.aDeath;
      entry.aAssist += g.aAssist;
      entry.bKill += g.bKill;
      entry.bDeath += g.bDeath;
      entry.bAssist += g.bAssist;
      map.set(key, entry);
    }

    return Array.from(map.values())
      .filter((e) => e.total >= this.MIN_MATCHUP_GAMES)
      .sort((a, b) => b.total - a.total)
      .map((e) => {
        const myKda = e.aDeath === 0 ? 9999 : Math.round(((e.aKill + e.aAssist) / e.aDeath) * 100) / 100;
        const opponentKda = e.bDeath === 0 ? 9999 : Math.round(((e.bKill + e.bAssist) / e.bDeath) * 100) / 100;
        const kdaDiff =
          myKda === 9999 || opponentKda === 9999
            ? 9999
            : Math.round((myKda - opponentKda) * 100) / 100;
        return {
          aPosition: position === 'ALL' ? null : position,
          aChampName: e.aChampName,
          aChampNameEng: e.aChampNameEng,
          bChampName: e.bChampName,
          bChampNameEng: e.bChampNameEng,
          total: e.total,
          win: e.win,
          lose: e.total - e.win,
          winRate: Math.round((e.win / e.total) * 1000) / 10,
          myKda,
          opponentKda,
          kdaDiff,
        };
      });
  }

  /**
   * @desc 아군일 때 자주 가는 챔피언 조합별 판수/듀오KDA/승률 집계 (판수 내림차순)
   * 듀오 KDA = 두 플레이어의 누적 K+A 합산 / 누적 D 합산
   */
  private calcDuoPicks(allyGames: EncounterRawGame[]): DuoPick[] {
    const map = new Map<
      string,
      {
        aChampName: string;
        aChampNameEng: string;
        bChampName: string;
        bChampNameEng: string;
        total: number;
        win: number;
        kill: number;
        death: number;
        assist: number;
      }
    >();

    for (const g of allyGames) {
      const key = `${g.aChampName}|${g.bChampName}`;
      const entry = map.get(key) ?? {
        aChampName: g.aChampName,
        aChampNameEng: g.aChampNameEng,
        bChampName: g.bChampName,
        bChampNameEng: g.bChampNameEng,
        total: 0,
        win: 0,
        kill: 0,
        death: 0,
        assist: 0,
      };
      entry.total++;
      if (g.aResult === '승') entry.win++;
      entry.kill += g.aKill + g.bKill;
      entry.death += g.aDeath + g.bDeath;
      entry.assist += g.aAssist + g.bAssist;
      map.set(key, entry);
    }

    return Array.from(map.values())
      .filter((e) => e.total >= this.MIN_MATCHUP_GAMES)
      .sort((a, b) => b.total - a.total)
      .map((e) => ({
        aChampName: e.aChampName,
        aChampNameEng: e.aChampNameEng,
        bChampName: e.bChampName,
        bChampNameEng: e.bChampNameEng,
        total: e.total,
        win: e.win,
        lose: e.total - e.win,
        winRate: Math.round((e.win / e.total) * 1000) / 10,
        duoKda: e.death === 0 ? 9999 : Math.round(((e.kill + e.assist) / e.death) * 100) / 100,
      }));
  }

  /**
   * @desc 공통 게임이 없을 때 반환할 빈 summary 구조체
   */
  private emptyEncounterSummary(playerA: EncounterPlayer, playerB: EncounterPlayer): EncounterSummary {
    const emptyScenario: EncounterScenario = { total: 0, win: 0, lose: 0 };
    const emptyKda: EncounterKda = { avgKill: 0, avgDeath: 0, avgAssist: 0, kda: 0 };
    const emptyMetrics: EncounterAvgMetrics = { avgDamage: 0, avgCsPerMin: 0, avgGoldPerMin: 0, avgVision: 0 };
    return {
      playerA,
      playerB,
      overall: emptyScenario,
      asEnemies: emptyScenario,
      asAllies: emptyScenario,
      avgGameTimeSec: 0,
      kda: { playerA: emptyKda, playerB: emptyKda },
      avgMetrics: { playerA: emptyMetrics, playerB: emptyMetrics },
      topChampions: { playerA: [], playerB: [] },
      laneMatrix: [],
      allyLaneMatrix: [],
      championMatchups: [],
      duoPicks: [],
      insights: [],
    };
  }
}

export const encounterService = new EncounterService();
