import { eq, and, desc, sql } from 'drizzle-orm';
import { get } from 'https';
import { createHash } from 'crypto';
import { db, DbOrTx, TransactionType } from '../database/connectionPool.js';
import { replay } from '../database/schema.js';
import { ReplayFileRequest } from '../types/replay.js';
import { BusinessError, SystemError } from '../types/error.js';
import { systemConfigService } from './systemConfig.service.js';

// 다운로드 데드라인 기본값(ms). 봇이 45초에 요청을 끊으므로 파싱·DB 저장 시간을 남겨야 한다.
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20000;
// 소켓 무응답 판정(ms). 데드라인과 별개로 둔다 — 헤더가 안 오거나 스트리밍이 멈춘 경우를
// 데드라인까지 기다리지 않고 끊기 위함이다.
const DOWNLOAD_IDLE_TIMEOUT_MS = 10000;

/**
 * @desc 리플레이 파일 서비스
 */
export class ReplayService {
  /**
   * @desc 주어진 데이터를 사용하여 SHA-256 해시를 생성
   */
  public generateHash = (data: string | Buffer): string => {
    return createHash('sha256').update(data).digest('hex');
  };

  /**
   * @desc 파일의 해시값과 길드 ID가 일치하는 중복 레코드의 존재 여부를 확인
   * @returns 중복된 레코드가 존재하면 true, 존재하지 않으면 false
   */
  public async checkDuplicateByHash(
    hashData: string,
    guildId: string,
    executor: DbOrTx = db,
  ): Promise<boolean> {
    const result = await executor
      .select({ id: replay.id })
      .from(replay)
      .where(
        and(
          eq(replay.hashData, hashData),
          eq(replay.guildId, guildId),
          eq(replay.isDeleted, false),
        ),
      )
      .limit(1);

    return result.length > 0;
  }

  /**
   * @desc 디스코드 파일 데이터 가져오기 (메모리 제한 + 타임아웃 적용)
   *
   * 타이머를 둘 둔다 — 데드라인은 전체 소요를 제한하고, 소켓 무응답은 CDN이 연결만
   * 수락하고 데이터를 보내지 않는 경우를 잡는다. 어느 쪽이든 요청을 destroy해야 하며,
   * 하지 않으면 봇이 45초에 포기한 뒤에도 커넥션이 남는다.
   */
  private async getInputStreamDiscordFile(fileUrl: string): Promise<Buffer> {
    const maxFileSize = await systemConfigService.getNumberConfig('MAX_REPLAY_FILE_SIZE', 52428800);
    const configuredTimeout = await systemConfigService.getNumberConfig(
      'REPLAY_DOWNLOAD_TIMEOUT_MS',
      DEFAULT_DOWNLOAD_TIMEOUT_MS,
    );
    // getNumberConfig는 값이 숫자가 아니면 NaN을 그대로 돌려준다. setTimeout(NaN)은 1ms로
    // 취급되어 모든 업로드가 즉시 504가 되므로 기본값으로 되돌린다.
    const downloadTimeout =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_DOWNLOAD_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      let settled = false;
      let deadlineId: NodeJS.Timeout | undefined;
      let req: ReturnType<typeof get> | undefined;

      // settled를 destroy보다 먼저 세워야 한다. res에 error 리스너가 붙은 뒤로는 destroy가
      // 매번 ECONNRESET을 올려보내는데, 순서가 뒤집히면 413·504마다 그게 로그로 샌다.
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineId);
        req?.destroy();
        reject(error);
      };

      const succeed = (buffer: Buffer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineId);
        resolve(buffer);
      };

      req = get(fileUrl, (res) => {
        // CDN이 에러 본문을 200이 아닌 상태로 내려주면 그 본문이 리플 파일로 취급되어
        // 파싱 실패(500)로 뭉개진다. 만료된 첨부 URL이 이 경로로 들어온다.
        // 3xx도 여기서 끊는다 — https.get은 리다이렉트를 따라가지 않아 빈 본문이 된다.
        if (res.statusCode && res.statusCode >= 300) {
          return fail(
            new SystemError(`Discord CDN이 ${res.statusCode}를 반환했습니다.`, 502, {
              type: 'discord-download-failed',
              title: 'Bad Gateway',
            }),
          );
        }

        // 헤더 수신 후 커넥션이 끊기면 Node는 req가 아니라 res로 에러를 보낸다.
        // 리스너가 없으면 그 에러가 삼켜져 데드라인까지 매달린다.
        res.on('error', (err) => {
          if (settled) return;
          console.error('Error getInputStreaming replay file', err);
          fail(
            new SystemError('Replay error while downloading file', 502, {
              type: 'discord-download-failed',
              title: 'Bad Gateway',
            }),
          );
        });

        // [1차 방어] Content-Length 헤더 확인 (제공되는 경우)
        const contentLength = res.headers['content-length'];
        if (contentLength && parseInt(contentLength, 10) > maxFileSize) {
          return fail(
            new BusinessError(`File too large. Max size is ${maxFileSize / 1024 / 1024}MB`, 413, {
              isLoggable: false,
            }),
          );
        }

        const data: Uint8Array[] = [];
        let currentSize = 0; // 현재 다운로드 된 크기 누적

        res.on('data', (chunk) => {
          currentSize += chunk.length;

          // [2차 방어] 다운로드 도중 실시간 크기 체크
          if (currentSize > maxFileSize) {
            return fail(
              new BusinessError(`File stream exceeded max size of ${maxFileSize} bytes`, 413, {
                isLoggable: true,
              }),
            );
          }
          return data.push(chunk);
        });

        return res.on('end', () => {
          // 데이터가 비어있거나 스트림이 비정상 종료된 경우 체크
          if (currentSize === 0) {
            return fail(new SystemError('Replay file is empty', 500));
          }

          return succeed(Buffer.concat(data));
        });
      });

      deadlineId = setTimeout(() => {
        fail(
          new SystemError(
            `Discord CDN 다운로드가 ${downloadTimeout}ms 안에 끝나지 않았습니다.`,
            504,
            { type: 'discord-download-timeout', title: 'Gateway Timeout' },
          ),
        );
      }, downloadTimeout);

      // 소켓 무응답은 connect 완료 후에만 무장된다. DNS·TCP·TLS가 매달리는 구간은
      // 데드라인만 잡을 수 있어 두 타이머 중 어느 쪽도 뺄 수 없다.
      req.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
        fail(
          new SystemError(
            `Discord CDN이 ${DOWNLOAD_IDLE_TIMEOUT_MS}ms 동안 응답하지 않았습니다.`,
            504,
            { type: 'discord-download-timeout', title: 'Gateway Timeout' },
          ),
        );
      });

      req.on('error', (err) => {
        // fail()이 destroy한 뒤 올라오는 ECONNRESET은 우리가 만든 것이라 로그로 남기지 않는다.
        if (settled) return;
        console.error('Error getInputStreaming replay file', err);
        fail(
          new SystemError('Replay error while downloading file', 502, {
            type: 'discord-download-failed',
            title: 'Bad Gateway',
          }),
        );
      });
    });
  }

  /**
   * @desc replay_code 생성 (RPY-YYMMDD-filename-id) 형식
   */
  private async generateReplayCode(fileName: string, executor: DbOrTx = db): Promise<string> {
    const seoulDateStr = new Date().toLocaleString('sv-SE', {
      timeZone: 'Asia/Seoul',
    });

    const datePart = seoulDateStr.split(' ')[0];
    const YYMMDD = datePart.substring(2).replace(/-/g, '');

    const prefix = `RPY-${YYMMDD}-${fileName}-`;

    const lastReplay = await executor
      .select({ id: replay.id })
      .from(replay)
      .orderBy(desc(replay.id))
      .limit(1);

    let nextSequence = 1;

    if (lastReplay.length > 0) {
      const lastCode = lastReplay[0].id;

      if (!Number.isNaN(lastCode)) {
        nextSequence = lastCode + 1;
      }
    }

    const sequencePart = nextSequence.toString();

    return `${prefix}${sequencePart}`;
  }

  /**
   * @desc 리플레이 데이터 파싱
   */
  public async parseReplayData(byte: Buffer): Promise<{ patchVersion: string; stats: any[] }> {

    // 1) 헤더에서 패치 버전 추출
    let patchVersion = 'unknown';
    try {
      const versionLength = byte[0x0e];
      if (versionLength > 0) {
        const gameVersion = byte.subarray(0x0f, 0x0f + versionLength).toString('ascii');
        const [major, minor] = gameVersion.split('.');
        if (major && minor) {
          patchVersion = `${major}.${minor}`;
        }
      }
    } catch {
      console.warn('Failed to extract patch version from replay header');
    }

    // 2) JSON 스탯 데이터 파싱
    const byteString = byte.toString('utf-8');
    const startIndex = byteString.indexOf('{"gameLength":');
    const endIndex = byteString.lastIndexOf('"}');

    try {
      const data = byteString
        .slice(startIndex, endIndex + 2)
        .replace(/\\/g, '')
        .replace(/"\[/g, '[')
        .replace(/\]"/g, ']');

      const rootNode = JSON.parse(data);
      const statsArray = rootNode.statsJson;

      return { patchVersion, stats: statsArray };
    } catch (error) {
      console.error('Error parsing replay data', error);
      throw new SystemError('replay error while parsing data');
    }
  }

  /**
   * @desc get rawdataes
   */
  public async getRawData(fileData: ReplayFileRequest) {
    const { fileUrl } = fileData;

    // 1. 리플레이 파일 데이터 가져오기
    const fileBuffer = await this.getInputStreamDiscordFile(fileUrl);

    // 2. 파일 파싱
    const parsed = await this.parseReplayData(fileBuffer);

    return { rawData: parsed.stats, patchVersion: parsed.patchVersion };
  }

  /**
   * @desc 리플레이 저장
   * @param {ReplayFileRequest} fileData
   */
  /**
   * @desc .rofl 파일의 magic bytes 검증 (첫 4바이트가 "RIOT"인지 확인)
   */
  public validateMagicBytes(buffer: Buffer): boolean {
    if (buffer.length < 4) return false;
    return buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x4f && buffer[3] === 0x54;
  }

  public async replaySave(
    fileData: ReplayFileRequest | { fileName: string; fileUrl: string; gameType?: string; createUser: string; guildId: string },
    rawData: any,
    tx: TransactionType,
    patchVersion?: string | null,
  ) {
    const { fileName, fileUrl, gameType, createUser } = fileData;
    const guildId = 'guild' in fileData ? fileData.guild.id : fileData.guildId;

    const rawDataString = JSON.stringify(rawData);
    const hashData = this.generateHash(rawDataString);

    // 1. 중복된 데이터 확인
    if (await this.checkDuplicateByHash(hashData, guildId, tx)) {
      throw new BusinessError('duplicated replay data', 400, { isLoggable: false });
    }

    const replayCode = await this.generateReplayCode(fileName, tx);
    const season = await systemConfigService.getConfigOrDefault('LOL_SEASON', 'error_season', tx);

    const newReplay = await tx
      .insert(replay)
      .values({
        replayCode,
        fileName,
        fileUrl,
        rawData,
        hashData,
        gameType: gameType ?? '1',
        season,
        patchVersion: patchVersion ?? undefined,
        createUser,
        guildId,
      })
      .returning({
        id: replay.id,
        replayCode: replay.replayCode,
        fileName: replay.fileName,
        fileUrl: replay.fileUrl,
        hashData: replay.hashData,
        gameType: replay.gameType,
        season: replay.season,
        patchVersion: replay.patchVersion,
        createUser: replay.createUser,
        guildId: replay.guildId,
        createDate: replay.createDate,
        updateDate: replay.updateDate,
        isDeleted: replay.isDeleted,
      });

    return newReplay[0];
  }

  /**
   * @desc 길드별 리플레이 목록 조회 (최신순, 페이지네이션)
   */
  public async findReplaysByGuild(guildId: string, page: number = 1, limit: number = 10) {
    const offset = (page - 1) * limit;

    const result = await db
      .select({
        id: replay.id,
        replayCode: replay.replayCode,
        fileName: replay.fileName,
        gameType: replay.gameType,
        season: replay.season,
        patchVersion: replay.patchVersion,
        createUser: replay.createUser,
        guildId: replay.guildId,
        createDate: replay.createDate,
      })
      .from(replay)
      .where(and(eq(replay.guildId, guildId), eq(replay.isDeleted, false)))
      .orderBy(desc(replay.createDate))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(replay)
      .where(and(eq(replay.guildId, guildId), eq(replay.isDeleted, false)));

    const totalCount = countResult[0]?.count || 0;

    return { result, totalCount };
  }

  /**
   * @desc 리플레이 코드를 사용하여 리플레이를 논리적으로 삭제
   */
  public async softDeleteReplayByCode(replayCode: string, tx: TransactionType) {
    const result = await tx
      .update(replay)
      .set({
        isDeleted: true,
        updateDate: new Date(),
      })
      .where(and(eq(replay.replayCode, replayCode), eq(replay.isDeleted, false)))
      .returning();

    return result[0];
  }
}

export const replayService = new ReplayService();
