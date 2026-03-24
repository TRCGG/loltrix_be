import { eq, and, desc } from 'drizzle-orm';
import { get } from 'https';
import { createHash } from 'crypto';
import { db, TransactionType } from '../database/connectionPool.js';
import { replay } from '../database/schema.js';
import { ReplayFileRequest } from '../types/replay.js';
import { BusinessError, SystemError } from '../types/error.js';

// 시즌
const season = process.env.LOL_SEASON || 'error_season';

// [추가] 리플레이 파일 최대 크기 제한 (50MB)
const MAX_REPLAY_FILE_SIZE = 50 * 1024 * 1024;

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
  public async checkDuplicateByHash(hashData: string, guildId: string): Promise<boolean> {
    const result = await db
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
   * @desc 디스코드 파일 데이터 가져오기 (메모리 제한 적용)
   */
  private async getInputStreamDiscordFile(fileUrl: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      get(fileUrl, (res) => {
        // [1차 방어] Content-Length 헤더 확인 (제공되는 경우)
        const contentLength = res.headers['content-length'];
        if (contentLength && parseInt(contentLength, 10) > MAX_REPLAY_FILE_SIZE) {
          res.destroy();
          return reject(
            new BusinessError(
              `File too large. Max size is ${MAX_REPLAY_FILE_SIZE / 1024 / 1024}MB`,
              413,
              { isLoggable: false },
            ),
          );
        }

        const data: Uint8Array[] = [];
        let currentSize = 0; // 현재 다운로드 된 크기 누적

        res.on('data', (chunk) => {
          currentSize += chunk.length;

          // [2차 방어] 다운로드 도중 실시간 크기 체크
          if (currentSize > MAX_REPLAY_FILE_SIZE) {
            res.destroy();
            return reject(
              new BusinessError(
                `File stream exceeded max size of ${MAX_REPLAY_FILE_SIZE} bytes`,
                413,
                { isLoggable: true },
              ),
            );
          }
          data.push(chunk);
        });

        res.on('end', () => {
          // 데이터가 비어있거나 스트림이 비정상 종료된 경우 체크
          if (currentSize === 0) {
            return reject(new SystemError('Replay file is empty', 500));
          }

          const buffer = Buffer.concat(data);
          resolve(buffer);
        });
      }).on('error', (err) => {
        console.error('Error getInputStreaming replay file', err);
        reject(new SystemError('Replay error while downloading file', 500));
      });
    });
  }

  /**
   * @desc replay_code 생성 (RPY-YYMMDD-filename-id) 형식
   */
  private async generateReplayCode(fileName: string): Promise<string> {
    const seoulDateStr = new Date().toLocaleString('sv-SE', {
      timeZone: 'Asia/Seoul',
    });

    const datePart = seoulDateStr.split(' ')[0];
    const YYMMDD = datePart.substring(2).replace(/-/g, '');

    const prefix = `RPY-${YYMMDD}-${fileName}-`;

    const lastReplay = await db
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
  public async parseReplayData(byte: Buffer): Promise<string> {
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

      return JSON.stringify(statsArray);
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
    const rawDataString = await this.parseReplayData(fileBuffer);
    const rawDataes = JSON.parse(rawDataString);

    return rawDataes;
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
    if (await this.checkDuplicateByHash(hashData, guildId)) {
      throw new BusinessError('duplicated replay data', 400, { isLoggable: false });
    }

    const replayCode = await this.generateReplayCode(fileName);

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
      .returning();

    return newReplay[0];
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
