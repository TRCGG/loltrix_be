import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import { once } from 'node:events';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AuthRequest } from '../middlewares/authHandler.js';
import { BusinessError } from '../types/error.js';

const createUploadTicket = jest.fn<(contentType: string) => Promise<unknown>>();
const getActiveRoles = jest.fn<(memberId: string) => Promise<{ role: string }[]>>();

jest.unstable_mockModule('../services/imageUpload.service.js', () => ({
  imageUploadService: { createUploadTicket },
}));
jest.unstable_mockModule('../services/discordMemberRole.service.js', () => ({
  discordMemberRoleService: { getActiveRoles },
}));
jest.unstable_mockModule('../services/guild.service.js', () => ({ guildService: {} }));
jest.unstable_mockModule('../services/discordGuildAccess.service.js', () => ({
  discordGuildAccessService: {},
}));

const { default: adminUploadRoutes } = await import('../routes/adminUpload.routes.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: AuthRequest, _res, next) => {
    req.discordMemberId = req.get('x-test-member');
    req.isBot = req.get('x-test-bot') === '1';
    next();
  });
  app.use('/api/admin/uploads', adminUploadRoutes);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/api/admin/uploads`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  createUploadTicket.mockReset();
  getActiveRoles.mockReset().mockResolvedValue([{ role: 'adminNormal' }]);
});

const post = (body: unknown, headers: Record<string, string> = { 'x-test-member': 'admin-1' }) =>
  fetch(`${base}/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const ticket = {
  url: 'https://s3.example/',
  fields: { key: 'dev/board/2026/11/a.webp' },
  publicUrl: 'https://img.gmok.kr/dev/board/2026/11/a.webp',
};

describe('POST /api/admin/uploads/images', () => {
  test('관리자는 업로드 허가를 받는다', async () => {
    createUploadTicket.mockResolvedValue(ticket);

    const res = await post({ contentType: 'image/webp' });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      status: 'success',
      message: 'Upload ticket issued successfully',
      data: ticket,
    });
    expect(createUploadTicket).toHaveBeenCalledWith('image/webp');
  });

  test.each(['image/gif', 'image/svg+xml', 'text/html', undefined])(
    '허용하지 않는 형식(%s)은 400',
    async (contentType) => {
      const res = await post({ contentType });
      expect(res.status).toBe(400);
      expect(createUploadTicket).not.toHaveBeenCalled();
    },
  );

  test('봇 요청은 403', async () => {
    const res = await post({ contentType: 'image/png' }, { 'x-test-bot': '1' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ message: 'Bot cannot upload images' });
    expect(createUploadTicket).not.toHaveBeenCalled();
  });

  test('admin 권한이 없으면 403', async () => {
    getActiveRoles.mockResolvedValue([{ role: 'userUploader' }]);
    const res = await post({ contentType: 'image/png' });
    expect(res.status).toBe(403);
    expect(createUploadTicket).not.toHaveBeenCalled();
  });

  test('서버에 S3 설정이 없으면 503을 message로 알린다', async () => {
    createUploadTicket.mockRejectedValue(
      new BusinessError('Image upload is not configured', 503, { showMessage: true }),
    );

    const res = await post({ contentType: 'image/jpeg' });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'error',
      message: 'Image upload is not configured',
      data: null,
    });
  });
});
