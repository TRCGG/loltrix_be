import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const listApplications = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();

jest.unstable_mockModule('../services/competition.service.js', () => ({
  competitionService: {},
}));
jest.unstable_mockModule('../services/competitionTeam.service.js', () => ({
  competitionTeamService: { listApplications },
  visibleApplicationStatus: jest.fn(),
}));
jest.unstable_mockModule('../services/competitionPlayer.service.js', () => ({
  competitionPlayerService: {},
}));
jest.unstable_mockModule('../middlewares/requireRole.js', () => ({
  hasGuildRole: jest.fn(),
}));

const { exportApplicationsCsv } = await import('../controllers/competition.controller.js');

beforeEach(() => {
  listApplications.mockReset().mockResolvedValue([]);
});

describe('exportApplicationsCsv', () => {
  test('대회 전체 신청 목록을 UTF-8 CSV 첨부파일로 내려준다', async () => {
    const headers: Record<string, string> = {};
    const send = jest.fn<(body: string) => void>();
    const res = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      status: jest.fn<(code: number) => { send: typeof send }>(() => ({ send })),
    };
    const next = jest.fn();

    await exportApplicationsCsv(
      { params: { guildId: 'guild-1', competitionId: '5' } } as unknown as Parameters<
        typeof exportApplicationsCsv
      >[0],
      res as unknown as Parameters<typeof exportApplicationsCsv>[1],
      next as unknown as Parameters<typeof exportApplicationsCsv>[2],
    );

    expect(listApplications).toHaveBeenCalledWith('guild-1', 5);
    expect(headers).toEqual({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="competition-5-applicants.csv"',
      'Cache-Control': 'private, no-store',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith(expect.stringMatching(/^\uFEFF"라이엇 이름"/));
    expect(next).not.toHaveBeenCalled();
  });
});
