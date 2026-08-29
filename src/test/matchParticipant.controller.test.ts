import { jest, describe, test, expect, beforeEach } from '@jest/globals';

type AsyncFn = (...args: any[]) => Promise<any>;

const getMostPicksSvc = jest.fn<AsyncFn>();
const getLineRecordSvc = jest.fn<AsyncFn>();
const searchGuildMemberByRiotId = jest.fn<AsyncFn>();
const getConfigOrDefault = jest.fn<AsyncFn>();

jest.unstable_mockModule('../services/matchParticipant.service.js', () => ({
  matchParticipantService: { getMostPicks: getMostPicksSvc, getLineRecord: getLineRecordSvc },
}));
jest.unstable_mockModule('../services/guildMember.service.js', () => ({
  guildMemberService: { searchGuildMemberByRiotId },
}));
jest.unstable_mockModule('../services/systemConfig.service.js', () => ({
  systemConfigService: { getConfigOrDefault },
}));

const { getMostPicks } = await import('../controllers/matchParticipant.controller.js');

const makeRes = () => {
  const json = jest.fn<(body: unknown) => unknown>();
  const status = jest.fn<(code: number) => { json: typeof json }>(() => ({ json }));
  const setHeader = jest.fn();
  return { status, json, setHeader };
};

const makeReq = (query: Record<string, string> = {}) =>
  ({
    params: { guildId: 'g1', riotName: 'hide on bush' },
    query: { riotNameTag: 'KR1', ...query },
  }) as any;

const mostPicks = [
  {
    champName: '아리',
    champNameEng: 'Ahri',
    totalCount: 12,
    win: 7,
    lose: 5,
    winRate: 58.33,
    kda: 3.2,
  },
];
const lines = [
  { position: 'MID', totalCount: 20, win: 11, lose: 9, winRate: 55, kda: 3.1 },
  { position: 'TOP', totalCount: 4, win: 1, lose: 3, winRate: 25, kda: 1.2 },
];

describe('getMostPicks - 응답 data에 포지션별 집계 lines 동봉', () => {
  beforeEach(() => {
    getConfigOrDefault.mockResolvedValue('2026');
    searchGuildMemberByRiotId.mockResolvedValue([{ playerCode: 'p1' }]);
    getMostPicksSvc.mockResolvedValue({ mostPicks, totalCount: 1 });
    getLineRecordSvc.mockResolvedValue(lines);
  });

  test('data에 getMostPicks 결과와 getLineRecord 결과를 함께 싣는다', async () => {
    const res = makeRes();

    await getMostPicks(makeReq({ position: 'MID' }), res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'success',
      message: 'Most picks retrieved successfully',
      data: { mostPicks, lines },
    });
  });

  test('lines는 position 파라미터와 무관하게 같은 시즌·길드·플레이어로 조회한다', async () => {
    await getMostPicks(makeReq({ position: 'TOP', season: '2025' }), makeRes() as any);

    expect(getLineRecordSvc).toHaveBeenCalledWith('p1', '2025', 'g1');
    expect(getMostPicksSvc).toHaveBeenCalledWith('p1', '2025', 'g1', 1, 10, 'TOP');
  });

  test('페이지네이션 헤더는 기존과 동일하게 세팅된다', async () => {
    const res = makeRes();

    await getMostPicks(makeReq({ page: '2', limit: '5' }), res as any);

    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '1');
    expect(res.setHeader).toHaveBeenCalledWith('X-Page', '2');
    expect(res.setHeader).toHaveBeenCalledWith('X-Limit', '5');
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Pages', '1');
  });

  test('getLineRecord가 실패하면 기존 catch 경로로 500을 낸다', async () => {
    getLineRecordSvc.mockRejectedValue(new Error('db down'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();

    await getMostPicks(makeReq(), res as any);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      message: 'Internal server error while retrieving most picks',
      data: null,
    });
    consoleError.mockRestore();
  });

  test('멤버가 없으면 404이고 집계는 호출하지 않는다', async () => {
    searchGuildMemberByRiotId.mockResolvedValue([]);
    const res = makeRes();

    await getMostPicks(makeReq(), res as any);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(getMostPicksSvc).not.toHaveBeenCalled();
    expect(getLineRecordSvc).not.toHaveBeenCalled();
  });

  test('멤버가 여럿이면 후보 목록만 돌려주고 lines·집계 없이 끝난다', async () => {
    searchGuildMemberByRiotId.mockResolvedValue([
      { playerCode: 'p1', riotName: 'hide on bush', riotNameTag: 'KR1', isMain: true },
      { playerCode: 'p2', riotName: 'hide on bush', riotNameTag: 'KR2', isMain: true },
    ]);
    const res = makeRes();

    await getMostPicks(makeReq(), res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'success',
      message: 'Multiple members found',
      data: [
        { playerCode: 'p1', riotName: 'hide on bush', riotNameTag: 'KR1' },
        { playerCode: 'p2', riotName: 'hide on bush', riotNameTag: 'KR2' },
      ],
    });
    expect(getMostPicksSvc).not.toHaveBeenCalled();
    expect(getLineRecordSvc).not.toHaveBeenCalled();
  });
});
