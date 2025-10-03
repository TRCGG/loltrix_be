import { eq, and, like, desc } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { replay } from '../database/schema.js';
import { ReplayFileRequest } from '../types/replay.js';
import { get } from 'https'; // http 또는 https 모듈
import { createHash } from 'crypto';
import { BusinessError, SystemError } from '../types/error.js';

/**
 * @desc 리플레이 파일 서비스
 */
export class ReplayService {
  constructor() {}

  /**
   * @desc 주어진 데이터를 사용하여 SHA-256 해시를 생성
   */
  private generateHash = (data: string | Buffer): string => {
    return createHash('sha256').update(data).digest('hex');
  };

  /**
   * @desc 파일의 해시값과 길드 ID가 일치하는 중복 레코드의 존재 여부를 확인
   * @returns 중복된 레코드가 존재하면 true, 존재하지 않으면 false
   */
  private async checkDuplicateByHash(hashData: string, guildId: string): Promise<boolean> {
    const result = await db
      .select({ id: replay.id })
      .from(replay)
      .where(and(eq(replay.hashData, hashData), eq(replay.guildId, guildId)))
      .limit(1);

    return result.length > 0;
  }

  /**
   * @desc 디스코드 파일 데이터 가져오기
   */
  private async getInputStreamDiscordFile(fileUrl: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      get(fileUrl, (res) => {
        const data: Uint8Array[] = [];
        res.on('data', (chunk) => {
          data.push(chunk);
        });
        res.on('end', () => {
          const buffer = Buffer.concat(data);
          if (buffer.length === 0) {
            throw new SystemError("replay file no data");
          }
          resolve(buffer);
        });
      }).on('error', (err) => {
        throw new SystemError("replay error while getInputStreaming file");
      });
    });
  }

  /**
   * @desc replay_code 생성 (RPY-YYMMDD-filename-id) 형식
   */
  private async generateReplayCode(fileName: string): Promise<string> {
    const datePart = new Date().toISOString().split('T')[0];
    const YYMMDD = datePart.substring(2).replace(/-/g, '');

    const prefix = `RPY-${YYMMDD}-${fileName}-`;

    const lastReplay = await db
      .select({ replayCode: replay.replayCode })
      .from(replay)
      .where(like(replay.replayCode, `${prefix}%`))
      .orderBy(desc(replay.replayCode))
      .limit(1);

    let nextSequence = 1;

    if (lastReplay.length > 0) {
      const lastCode = lastReplay[0].replayCode;
      const parts = lastCode.split('-');
      const lastSequenceStr = parts[parts.length - 1];
      const lastSequence = parseInt(lastSequenceStr, 10);

      if (!isNaN(lastSequence)) {
        nextSequence = lastSequence + 1;
      }
    }

    const sequencePart = nextSequence.toString();

    return `${prefix}${sequencePart}`;
  }

   /**
   * @desc 리플레이 데이터 파싱
   */
  private async parseReplayData(byte: Buffer): Promise<string> {
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
      throw new SystemError("replay error while parsing data");
    }
  }

  /**
   * @desc 리플레이 저장 및 처리
   * @param {ReplayFileRequest} fileData
   */
  public async save(fileData: ReplayFileRequest) {
    const { fileName, fileUrl, gameType, createUser, guildId } = fileData;

    // 1. 리플레이 파일 데이터 가져오기
    const fileBuffer = await this.getInputStreamDiscordFile(fileUrl);

    // 2. 파일 파싱
    const rawDataString = await this.parseReplayData(fileBuffer);
    const rawData = JSON.parse(rawDataString);

    // 3. 해시 생성
    const hashData = this.generateHash(rawDataString);

    // 4. 중복된 데이터 확인
    if (await this.checkDuplicateByHash(hashData, guildId)) {
      throw new BusinessError("duplicated replay data", 400, {"isLoggable": false});
    }

    const replayCode = await this.generateReplayCode(fileName);

    const newReplay = await db
      .insert(replay)
      .values({
        replayCode,
        fileName,
        fileUrl,
        rawData,
        hashData,
        gameType: gameType ?? '1',
        createUser,
        guildId,
      })
      .returning();

    return newReplay[0];
  }

  /**
   * @desc 리플레이 코드를 사용하여 리플레이를 논리적으로 삭제
   */
  public async softDeleteReplayByCode(replayCode: string) {
    const result = await db
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