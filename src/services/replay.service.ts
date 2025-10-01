import { eq, and, like, desc } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { replay } from '../database/schema.js';
import { ReplayFileRequest } from '../types/replay.js';
import { get } from 'https';
import { createHash } from 'crypto';
import { CustomError } from '../utils/customError.util.js';
import { MessageService } from './message.service.js';

/**
 * @desc 리플레이 파일 처리
 */
export class ReplayService {
  private messageService: MessageService;

  constructor(messageService: MessageService) {
    this.messageService = messageService;
  }

  /**
   * @desc 주어진 데이터를 사용하여 SHA-256 해시를 생성
   */
  private static generateHash(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * @desc 디스코드 파일 데이터 가져오기
   */
  private async getInputStreamDiscordFile(fileUrl: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      get(fileUrl, async (res) => {
        const data: Uint8Array[] = [];
        res.on('data', (chunk) => {
          data.push(chunk);
        });
        res.on('end', async () => {
          const buffer = Buffer.concat(data);
          if (buffer.length === 0) {
            console.error('replay file data is empty');
            reject();
          }
          resolve(buffer);
        });
      }).on('error', async (err) => {
        console.error('replay download fail');
        reject();
      });
    });
  }

  /**
   * @desc 리플레이 데이터 파싱
   */
  private async parseReplayData(byte: Buffer, locale: string): Promise<string> {
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
      throw new Error("parsing error");
    }
  }

  /**
   * @desc 파일의 해시값과 길드 ID가 일치하는 중복 레코드의 존재 여부를 확인
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
   * @desc replay_code 생성
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
   * @desc 리플레이 저장 및 처리
   * @param {ReplayFileRequest} fileData
   */
  public async save(fileData: ReplayFileRequest, locale: string) {
    const { fileName, fileUrl, gameType, createUser, guildId } = fileData;

    // 1. 리플레이 파일 데이터 가져오기
    const fileBuffer = await this.getInputStreamDiscordFile(fileUrl);

    // 2. 파일 파싱
    const rawDataString = await this.parseReplayData(fileBuffer, locale);
    const rawData = JSON.parse(rawDataString);

    // 3. 해시 생성
    const hashData = ReplayService.generateHash(rawDataString);

    // 4. 중복된 데이터 확인
    if (await this.checkDuplicateByHash(hashData, guildId)) {
      const message =
        (await this.messageService.getMessage(
          locale,
          'replay_validate_duplicate_hash',
        )) || 'Replay file data duplicated.';
      throw new CustomError(409, message);
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
