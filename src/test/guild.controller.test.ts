import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { Request, Response } from 'express';
import type { Guild } from '../database/schema.js';
import type { CreateGuildRequest, GuildResponse } from '../types/guild.js';

const insertGuild = jest.fn<(data: unknown) => Promise<{ guild: Guild; created: boolean }>>();

jest.unstable_mockModule('../services/guild.service.js', () => ({
  guildService: { insertGuild },
}));

const { createGuild } = await import('../controllers/guild.controller.js');

const makeRes = () => {
  const json = jest.fn<(body: GuildResponse) => unknown>();
  const status = jest.fn<(code: number) => { json: typeof json }>(() => ({ json }));
  return { status, json };
};

const call = (res: ReturnType<typeof makeRes>) =>
  createGuild(
    { body: { guildId: '1', guildName: '길드' } } as Request<
      Record<string, never>,
      GuildResponse,
      CreateGuildRequest
    >,
    res as unknown as Response<GuildResponse>,
  );

const row = (isDeleted: boolean) => ({ id: '1', name: '길드', isDeleted }) as Guild;

describe('createGuild', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  test('새 길드는 201', async () => {
    insertGuild.mockResolvedValue({ guild: row(false), created: true });
    const res = makeRes();

    await call(res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: row(false) }));
  });

  test('이미 있는 길드는 실패하지 않고 기존 행을 200으로 반환한다 (삭제 상태 포함)', async () => {
    insertGuild.mockResolvedValue({ guild: row(true), created: false });
    const res = makeRes();

    await call(res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isDeleted: true }) }),
    );
  });
});
