import { describe, expect, jest, test } from '@jest/globals';
import { sql } from 'drizzle-orm';
import { AnyPgColumn, PgDialect } from 'drizzle-orm/pg-core';

type Row = Record<string, unknown>;

const selected: Record<string, unknown>[] = [];
let againstRows: Row[] = [];

const project = (fields: Row, row: Row): Row =>
  Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]));

const db = {
  select: (fields: Row) => {
    selected.push(fields);
    const builder: Row = {};
    ['from', 'where', 'limit', 'orderBy', 'innerJoin', 'leftJoin'].forEach((method) => {
      builder[method] = () => builder;
    });
    builder.then = (resolve: (rows: Row[]) => unknown, reject: (error: unknown) => unknown) => {
      let rows: Row[];
      if ('puuid' in fields) {
        rows = [{ puuid: 'puuid', riotName: 'name', riotNameTag: 'KR1' }];
      } else if ('mostLane' in fields) {
        rows = [{ mostLane: 'MID', total: 4, wins: 2, avgKda: '3' }];
      } else if ('meDmg' in fields) {
        rows = againstRows;
      } else {
        rows = [];
      }
      return Promise.resolve(rows.map((row) => project(fields, row))).then(resolve, reject);
    };
    return builder;
  },
};

jest.unstable_mockModule('../database/connectionPool.js', () => ({ db }));

const { H2hService } = await import('../services/h2h.service.js');

const baseRow = (matchId: string, hoursAgo: number, over: Row = {}): Row => ({
  meCustomMatchId: matchId,
  mePlayedDate: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
  meSeason: '2026',
  meResult: 1,
  mePosition: 'MID',
  opPosition: 'MID',
  meChampionId: 'Ahri',
  opChampionId: 'Zed',
  meChamp: 'Ahri',
  opChamp: 'Zed',
  meGameLen: 1800,
  opGameLen: 900,
  meDmg: 18000,
  opDmg: 18000,
  meDpm: 111,
  opDpm: 222,
  meTd15: 0,
  opTd15: 2,
  meKills: 3,
  meDeaths: 1,
  meAssists: 4,
  opKills: 2,
  opDeaths: 3,
  opAssists: 1,
  ...over,
});

describe('H2hService.getH2hDetail — raw participant durations', () => {
  test('each side uses its selected duration; invalid durations keep games but exclude metric pairs', async () => {
    selected.length = 0;
    againstRows = [
      baseRow('valid', 4),
      baseRow('op-null', 3, { opGameLen: null, meResult: 0 }),
      baseRow('op-zero', 2, { opGameLen: 0 }),
      baseRow('me-zero', 1, { meGameLen: 0, meResult: 0 }),
    ];

    const detail = await new H2hService().getH2hDetail('guild', 'mine', 'theirs', {
      season: '2026',
      period: 'all',
      myPosition: null,
      sameLaneOnly: false,
      recentLimit: 10,
      recentOffset: 0,
    });

    const rawSelect = selected.find((fields) => 'meDmg' in fields);
    expect(rawSelect).toHaveProperty('opGameLen');
    expect(new PgDialect().sqlToQuery(sql`${rawSelect?.opGameLen as AnyPgColumn}`).sql).toBe(
      '"op_ag"."game_duration"',
    );
    const analysis = detail.against.recentAnalysis;
    const lane = analysis.lanes[0];
    const dpm = lane.metrics.find((metric) => metric.key === 'dpm')!;
    expect(detail.against).toMatchObject({ games: 4, wins: 2, losses: 2 });
    expect(detail.against.mine.dpm).toBe(111);
    expect(detail.against.oppos.dpm).toBe(222);
    expect(analysis).toMatchObject({ games: 4, wins: 2, losses: 2 });
    expect(lane).toMatchObject({ games: 4, wins: 2, losses: 2 });
    expect(dpm).toMatchObject({
      validGames: 1,
      myAvg: 600,
      oppoAvg: 1200,
      diff: -600,
      ahead: 0,
      tie: 0,
      behind: 1,
    });
    expect(dpm.perGame).toEqual([
      { matchId: 'me-zero', mine: null, oppo: 1200 },
      { matchId: 'op-zero', mine: 600, oppo: null },
      { matchId: 'op-null', mine: 600, oppo: null },
      { matchId: 'valid', mine: 600, oppo: 1200 },
    ]);
    expect(lane.matchIds).toEqual(dpm.perGame.map((game) => game.matchId));
    expect(detail.against.recent[0]).toMatchObject({
      matchId: 'me-zero',
      gameLen: 0,
      detail: { mine: { dmg: 18000 }, oppo: { dmg: 18000 } },
    });
    expect(detail.totalMet).toBe(4);
    expect(detail.together.games).toBe(0);
  });
});
