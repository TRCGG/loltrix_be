import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { Request, Response } from 'express';
import { ChampionListAPIResponse, ChampionListItem } from '../types/champion.js';

const getAll = jest.fn<() => Promise<ChampionListItem[]>>();

jest.unstable_mockModule('../services/champion.service.js', () => ({
  championService: { getAll },
}));

const { getChampions } = await import('../controllers/champion.controller.js');

const makeRes = () => {
  const json = jest.fn<(body: ChampionListAPIResponse) => unknown>();
  const status = jest.fn<(code: number) => { json: typeof json }>(() => ({ json }));
  return { status, json };
};

const call = async (res: ReturnType<typeof makeRes>) =>
  getChampions({} as Request, res as unknown as Response<ChampionListAPIResponse>);

const champions: ChampionListItem[] = [
  { id: 'CHN_1', champName: '아트록스', champNameEng: 'Aatrox', riotKey: 266 },
];

describe('getChampions', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  test('조회 성공은 200 + 목록', async () => {
    getAll.mockResolvedValue(champions);
    const res = makeRes();

    await call(res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'success',
      message: 'Champions retrieved successfully',
      data: champions,
    });
  });

  test('조회 실패는 500', async () => {
    getAll.mockRejectedValue(new Error('db down'));
    const res = makeRes();

    await call(res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      message: 'Internal server error while retrieving champions',
      data: null,
    });
  });
});
