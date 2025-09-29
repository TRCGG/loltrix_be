import { eq, and, like, desc } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { replay } from '../database/schema.js';
import { ReplayFileRequest } from '../types/replay.js';
import { get } from 'https'; // http 또는 https 모듈
import { createHash } from 'crypto';
import { CustomError } from '../utils/customError.util.js';

/**
 * @desc 주어진 데이터를 사용하여 SHA-256 해시를 생성
 */
const generateHash = (data: string | Buffer): string => {
  return createHash('sha256').update(data).digest('hex');
};

/**
 * @desc 파일의 해시값과 길드 ID가 일치하는 중복 레코드의 존재 여부를 확인
 * @returns 중복된 레코드가 존재하면 true, 존재하지 않으면 false
 */
export const checkDuplicateByHash = async (hashData: string, guildId: string): Promise<boolean> => {
    const result = await db
        .select({ id: replay.id })
        .from(replay)
        .where(and(eq(replay.hashData, hashData), eq(replay.guildId, guildId)))
        .limit(1);

    return result.length > 0; 
};

/**
 * @desc 디스코드 파일 데이터 가져오기
 */
const getInputStreamDiscordFile = async (fileUrl: string): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    get(fileUrl, (res) => {
      const data: Uint8Array[] = [];
      res.on('data', (chunk) => {
        data.push(chunk);
      });
      res.on('end', () => {
        const buffer = Buffer.concat(data);
        if (buffer.length === 0) {
          reject();
        }
        resolve(buffer);
      });
    }).on('error', (err) => {
      reject();
    });
  });
};

/**
 * @desc replay_code 생성 (RPY-YYMMDD-filename-순차번호)
 * @param fileName 파일 이름 (예: '리플파일이름')
 * @returns 생성된 replayCode 문자열
 */
const generateReplayCode = async (fileName: string): Promise<string> => {
    // 현재 날짜 (YYMMDD) 생성
    const datePart = new Date().toISOString().split('T')[0];
    const YYMMDD = datePart.substring(2).replace(/-/g, '');

    const prefix = `RPY-${YYMMDD}-${fileName}-`;

    // DB에서 오늘 날짜의 가장 최신 replayCode 검색
    const lastReplay = await db
        .select({ replayCode: replay.replayCode })
        .from(replay)
        .where(like(replay.replayCode, `${prefix}%`)) 
        .orderBy(desc(replay.replayCode)) 
        .limit(1);

    // 순차 번호 계산
    let nextSequence = 1;

    if (lastReplay.length > 0) {
        // 가장 최신 코드 (예: RPY-250928-리플파일이름-005)
        const lastCode = lastReplay[0].replayCode;
        
        // 마지막 하이픈 뒤의 순차 번호 부분만 추출
        const parts = lastCode.split('-');
        const lastSequenceStr = parts[parts.length - 1]; // 예: '005'
        
        const lastSequence = parseInt(lastSequenceStr, 10);
        
        // 유효한 숫자인지 확인하고 다음 순차 번호를 설정
        if (!isNaN(lastSequence)) {
            nextSequence = lastSequence + 1;
        }
    }
    
    // 순차 번호를 문자열로 포맷팅 (예: 1 -> '001', 12 -> '012')
    const sequencePart = nextSequence.toString();

    const finalReplayCode = `${prefix}${sequencePart}`;

    return finalReplayCode;
};

// 리플레이 데이터 파싱
const parseReplayData = async (byte: Buffer): Promise<string> => {
  const byteString = byte.toString('utf-8');

  const startIndex = byteString.indexOf('{"gameLength":');
  const endIndex = byteString.lastIndexOf('"}');

  if (!byteString || byteString.length === 0 || startIndex === -1 || endIndex === -1) {
    // TO-DO messageKey
    throw new CustomError(500, 'no parsing data');
  }

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
    // TO-DO messageKey
    console.error(`파싱 에러: ${error}`);
    throw new CustomError(500, 'parsing error');
  }
};

/**
 * @desc 리플레이 저장 및 처리
 * @param {ReplayFileRequest} fileData
 * @desc 리플레이 파일 처리 및 데이터베이스 저장
 */
export const save = async (fileData: ReplayFileRequest) => {
  const { fileName, fileUrl, gameType, createUser, guildId } = fileData;

  // 1. 리플레이 파일 데이터 가져오기
  const fileBuffer = await getInputStreamDiscordFile(fileUrl);

  // 2. 파일 파싱
  const rawDataString = await parseReplayData(fileBuffer);
  const rawData = JSON.parse(rawDataString);

  // 3. 해시 생성 (파싱된 JSON 문자열 사용)
  const hashData = generateHash(rawDataString);

  // 4. 중복된 데이터 확인
  if ((await checkDuplicateByHash(hashData, guildId))) {
    // TO-DO messageKey
    throw new CustomError(409, 'replay file data duplicated');
  }

  const replayCode = await generateReplayCode(fileName);

  const newReplay = await db.insert(replay).values({
    replayCode,
    fileName,
    fileUrl,
    rawData, 
    hashData,
    gameType: gameType ?? '1',
    createUser,
    guildId,
  }).returning();
  return newReplay[0];
};

/**
 * @desc ID로 리플레이 논리적 삭제
 */
/**
 * @desc 리플레이 코드를 사용하여 리플레이를 논리적으로 삭제합니다.
 * @param replayCode 삭제할 리플레이의 고유 코드 (예: RPY-250928-filename-1)
 */
export const softDeleteReplayByCode = async (replayCode: string) => {
  const result = await db
      .update(replay)
      .set({ 
          isDeleted: true,
          updateDate: new Date(), 
      })
      .where(
          and(
              eq(replay.replayCode, replayCode), 
              eq(replay.isDeleted, false)        
          )
      )
      .returning();
  
  return result[0];
};