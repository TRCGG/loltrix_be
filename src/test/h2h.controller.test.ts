import { jest, describe, test, expect, beforeEach } from '@jest/globals';

type AsyncFn = (...args: any[]) => Promise<any>;

const getH2hDetailSvc = jest.fn<AsyncFn>();
const searchGuildMemberByRiotId = jest.fn<AsyncFn>();
const getConfigOrDefault = jest.fn<AsyncFn>();

jest.unstable_mockModule('../services/h2h.service.js', () => ({
  h2hService: { getH2hDetail: getH2hDetailSvc, getFrequentOpponents: jest.fn<AsyncFn>() },
}));
jest.unstable_mockModule('../services/guildMember.service.js', () => ({
  guildMemberService: { searchGuildMemberByRiotId },
}));
jest.unstable_mockModule('../services/systemConfig.service.js', () => ({
  systemConfigService: { getConfigOrDefault },
}));

const { getH2hDetail } = await import('../controllers/h2h.controller.js');

const makeRes = () => {
  const json = jest.fn<(body: unknown) => unknown>();
  const status = jest.fn<(code: number) => { json: typeof json }>(() => ({ json }));
  return { status, json };
};

const run = async (query: Record<string, string>) => {
  const res = makeRes();
  await getH2hDetail(
    { params: { guildId: 'g1' }, query: { riotName1: 'a', riotName2: 'b', ...query } } as any,
    res as any,
  );
  return getH2hDetailSvc.mock.calls[0]?.[3];
};

describe('getH2hDetail — 필터 파라미터 파싱', () => {
  beforeEach(() => {
    getConfigOrDefault.mockResolvedValue('2026');
    searchGuildMemberByRiotId
      .mockResolvedValueOnce([{ playerCode: 'p1', riotName: 'a', riotNameTag: 'KR1' }])
      .mockResolvedValueOnce([{ playerCode: 'p2', riotName: 'b', riotNameTag: 'KR1' }]);
    getH2hDetailSvc.mockResolvedValue({});
  });

  test('생략 시 기간 전체·포지션 전체·맞라인 해제', async () => {
    expect(await run({})).toMatchObject({
      season: '2026',
      period: 'all',
      myPosition: null,
      sameLaneOnly: false,
    });
  });

  test("문자열 'false'는 false, 'true'만 true", async () => {
    expect((await run({ sameLaneOnly: 'false' })).sameLaneOnly).toBe(false);
  });

  test("'true'·포지션·30d는 그대로 전달되고 시즌 계약은 유지된다", async () => {
    expect(
      await run({ sameLaneOnly: 'true', myPosition: 'MID', period: '30d', season: 'all' }),
    ).toMatchObject({ season: null, period: '30d', myPosition: 'MID', sameLaneOnly: true });
  });
});
