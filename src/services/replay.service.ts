import { eq, and, desc, sql } from 'drizzle-orm';
import { get } from 'https';
import { createHash } from 'crypto';
import { db, DbOrTx, TransactionType } from '../database/connectionPool.js';
import { replay } from '../database/schema.js';
import { ReplayFileRequest } from '../types/replay.js';
import { BusinessError, SystemError } from '../types/error.js';
import { systemConfigService } from './systemConfig.service.js';

// 다운로드 예산 기본값(ms). 봇이 45초에 요청을 끊으므로 파싱·DB 저장 시간을 남겨야 한다.
// 이 예산은 getRawData의 다운로드 전체(Range 최대 3번 + 전체 폴백)가 나눠 쓴다 —
// 요청별로 걸면 직렬 최대 4번이라 최악 상한이 예산×4가 되어 봇 45초 보장이 깨진다.
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20000;
// 소켓 무응답 판정(ms). 데드라인과 별개로 둔다 — 헤더가 안 오거나 스트리밍이 멈춘 경우를
// 데드라인까지 기다리지 않고 끊기 위함이다.
const DOWNLOAD_IDLE_TIMEOUT_MS = 10000;

// .rofl 신형(패치 14.11+) 레이아웃 — 헤더("RIOT" 매직·버전 문자열, 288바이트) 뒤에 재생용
// 암호화 페이로드가 오고, 메타데이터(statsJson 포함) JSON이 **파일 끝**에 붙는다:
// 마지막 4바이트(uint32 LE)가 메타데이터 길이, 그 앞 length 바이트가 메타데이터 본문.
// 우리는 메타데이터만 쓰므로 전체(수십 MB)를 받을 이유가 없다.
// 주의: 구형(~14.10)의 헤더 오프셋 필드(262-287)는 신형 파일에서 무의미한 값이 들어
// 있으므로 위치 계산에는 절대 쓰지 않는다 (26.x 리플 실측으로 확인). 단 구형 파일
// 판별(isLegacyLayout)의 비교값으로만 읽는다 — 구형은 미지원 안내 대상이다 (TRC-269).
// 레이아웃 근거: gzordrai/rofl-parser.js NewROFLParser + 로컬 리플 실측.
const ROFL_HEADER_LENGTH = 288;
const ROFL_TAIL_SIZE_BYTES = 4;
// 구형 헤더 오프셋 블록(262-287) 중 판별에 쓰는 두 필드 (13.6 리플 실측):
// @262 uint16 = 헤더 길이(288), @264 uint32 = 파일 전체 길이
const ROFL_LEGACY_HEADER_LENGTH_OFFSET = 262;
const ROFL_LEGACY_FILE_LENGTH_OFFSET = 264;
// 메타데이터 길이 sanity 상한 — 실측 ~120KB. 꼬리 4바이트가 우연히 큰 수를 가리키면
// 구조 불일치로 보고 전체 다운로드로 폴백하기 위한 방어값.
const ROFL_METADATA_MAX_BYTES = 8 * 1024 * 1024;

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
   *
   * range를 주면 해당 바이트 구간만 요청한다. suffix는 파일 끝에서 N바이트(bytes=-N) —
   * 전체 크기를 몰라도 꼬리를 집을 수 있다. CDN이 Range를 지원하면 206으로 그 구간만
   * 오고, 미지원이면 200으로 전체가 온다 — 200을 여기서 끊으면 전체 다운로드가 한 번 더
   * 필요해지므로 그대로 받고, 어느 쪽이었는지는 statusCode로 호출부가 판단한다.
   */
  private async downloadDiscordFile(
    fileUrl: string,
    limits: { maxFileSize: number; timeoutMs: number },
    range?: { start: number; end: number } | { suffix: number },
  ): Promise<{ buffer: Buffer; statusCode: number }> {
    const { maxFileSize, timeoutMs } = limits;

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

      const succeed = (buffer: Buffer, statusCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineId);
        resolve({ buffer, statusCode });
      };

      const requestOptions = range
        ? {
            headers: {
              Range:
                'suffix' in range
                  ? `bytes=-${range.suffix}`
                  : `bytes=${range.start}-${range.end}`,
            },
          }
        : {};

      req = get(fileUrl, requestOptions, (res) => {
        // CDN이 에러 본문을 200이 아닌 상태로 내려주면 그 본문이 리플 파일로 취급되어
        // 파싱 실패(500)로 뭉개진다. 만료된 첨부 URL이 이 경로로 들어온다.
        // 3xx도 여기서 끊는다 — https.get은 리다이렉트를 따라가지 않아 빈 본문이 된다.
        // (Range 응답 206은 300 미만이라 이 검사를 그대로 통과한다.)
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

          return succeed(Buffer.concat(data), res.statusCode ?? 200);
        });
      });

      deadlineId = setTimeout(() => {
        fail(
          new SystemError(
            `Discord CDN 다운로드가 ${timeoutMs}ms 안에 끝나지 않았습니다.`,
            504,
            { type: 'discord-download-timeout', title: 'Gateway Timeout' },
          ),
        );
      }, timeoutMs);

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

  private async loadDownloadLimits(): Promise<{ maxFileSize: number; timeoutMs: number }> {
    const maxFileSize = await systemConfigService.getNumberConfig('MAX_REPLAY_FILE_SIZE', 52428800);
    const configuredTimeout = await systemConfigService.getNumberConfig(
      'REPLAY_DOWNLOAD_TIMEOUT_MS',
      DEFAULT_DOWNLOAD_TIMEOUT_MS,
    );
    // getNumberConfig는 값이 숫자가 아니면 NaN을 그대로 돌려준다. setTimeout(NaN)은 1ms로
    // 취급되어 모든 업로드가 즉시 504가 되므로 기본값으로 되돌린다.
    const timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_DOWNLOAD_TIMEOUT_MS;

    return { maxFileSize, timeoutMs };
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
   * @desc 헤더에서 패치 버전 추출 (헤더 288바이트만 있어도 동작)
   */
  private parsePatchVersion(byte: Buffer): string {
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
    return patchVersion;
  }

  /**
   * @desc 구형(~14.10) 레이아웃 판별. 구형은 메타데이터가 파일 앞에 있어 파일 끝을
   * 전제한 파싱이 암호화 페이로드를 물고 들어가 깨진다 — 미지원으로 안내한다.
   * 신형 파일의 262-287 자리는 무의미한 값이라 두 필드가 동시에 들어맞을 일이 없다.
   */
  private isLegacyLayout(byte: Buffer): boolean {
    if (byte.length <= ROFL_HEADER_LENGTH) return false;
    return (
      byte.readUInt16LE(ROFL_LEGACY_HEADER_LENGTH_OFFSET) === ROFL_HEADER_LENGTH &&
      byte.readUInt32LE(ROFL_LEGACY_FILE_LENGTH_OFFSET) === byte.length
    );
  }

  /**
   * @desc 전체 파일 버퍼에서 신형 레이아웃 기준으로 메타데이터 구간을 잘라낸다.
   * 값이 레이아웃과 안 맞으면(구형·비정상 파일) null — 호출부는 전체 스캔으로 폴백한다.
   */
  private sliceMetadataFromFile(byte: Buffer): Buffer | null {
    if (byte.length <= ROFL_HEADER_LENGTH + ROFL_TAIL_SIZE_BYTES) return null;

    const metaLength = byte.readUInt32LE(byte.length - ROFL_TAIL_SIZE_BYTES);
    const start = byte.length - ROFL_TAIL_SIZE_BYTES - metaLength;
    if (metaLength <= 0 || metaLength > ROFL_METADATA_MAX_BYTES || start < ROFL_HEADER_LENGTH) {
      return null;
    }

    return byte.subarray(start, start + metaLength);
  }

  /**
   * @desc 메타데이터 JSON 문자열에서 statsJson 배열 추출
   */
  private parseStatsString(byteString: string): any[] {
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

      return statsArray;
    } catch (error) {
      console.error('Error parsing replay data', error);
      throw new SystemError('replay error while parsing data');
    }
  }

  /**
   * @desc 리플레이 데이터 파싱 (파일 전체 버퍼 대상 — 웹 업로드·폴백 경로)
   */
  public async parseReplayData(byte: Buffer): Promise<{ patchVersion: string; stats: any[] }> {
    if (this.isLegacyLayout(byte)) {
      throw new BusinessError('구형 리플 파일(패치 14.11 이전)이라 등록할 수 없습니다.', 400, {
        type: 'unsupported-replay-version',
        title: 'Unsupported Replay Version',
        isLoggable: false,
      });
    }

    const patchVersion = this.parsePatchVersion(byte);

    // 파일 끝 길이 필드로 메타데이터 구간만 문자열화한다. 수십 MB 전체를 toString하고
    // 전역 정규식을 돌리면 이벤트 루프가 그동안 통째로 막힌다.
    const meta = this.sliceMetadataFromFile(byte);
    if (meta) {
      try {
        return { patchVersion, stats: this.parseStatsString(meta.toString('utf-8')) };
      } catch {
        // 구간이 파싱되지 않는 파일 — 기존 전체 스캔으로 폴백
      }
    }

    return { patchVersion, stats: this.parseStatsString(byte.toString('utf-8')) };
  }

  /**
   * @desc CDN에서 리플 데이터 확보 — Range로 헤더 + 파일 끝 메타데이터 구간만 받는다.
   *
   * statsJson은 파일 끝 메타데이터에 있고 가운데는 쓰지 않는 암호화 페이로드라, 전체
   * (수십 MB) 다운로드가 데드라인(TRC-261, 20초)을 넘기던 문제를 다운로드량 자체를
   * 줄여 없앤다 (~120KB 수준). Range 미지원(200)·구조 불일치·구간 파싱 실패는 모두
   * 전체 다운로드 + 기존 파싱으로 폴백해 에러 의미(502/504/파싱 500)를 그대로 유지한다.
   */
  public async getRawData(fileData: ReplayFileRequest) {
    const { fileUrl } = fileData;

    const limits = await this.loadDownloadLimits();
    // 다운로드 예산은 아래 요청 전체가 공유한다. 요청마다 남은 예산으로 데드라인을 걸고,
    // 소진됐으면 요청 없이 바로 504 — 어떤 경로를 타든 다운로드 합계가 예산을 넘지 않는다.
    const deadlineAt = Date.now() + limits.timeoutMs;
    const download = (range?: { start: number; end: number } | { suffix: number }) => {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new SystemError(
          `Discord CDN 다운로드가 ${limits.timeoutMs}ms 안에 끝나지 않았습니다.`,
          504,
          { type: 'discord-download-timeout', title: 'Gateway Timeout' },
        );
      }
      return this.downloadDiscordFile(
        fileUrl,
        { maxFileSize: limits.maxFileSize, timeoutMs: remainingMs },
        range,
      );
    };

    // 200 응답은 이미 전체 파일을 받은 것 — 폴백 때 재다운로드하지 않도록 들고 있는다.
    // (>=300은 downloadDiscordFile이 502로 던지므로 여기 오는 건 200 아니면 206뿐)
    // suffix 요청이 파일보다 길 때도 마찬가지다 — RFC 9110상 전체 표현이 오므로(206이어도
    // 요청보다 짧으면 그것) 그대로 전체 파일로 쓴다.
    let fullBuffer: Buffer | null = null;

    // 1. 헤더 288바이트 — 매직·패치버전. 만료 URL 등 CDN 에러는 여기서 502로 끊긴다.
    const header = await download({ start: 0, end: ROFL_HEADER_LENGTH - 1 });
    if (header.statusCode !== 206) fullBuffer = header.buffer;

    if (!fullBuffer && this.validateMagicBytes(header.buffer)) {
      // 2. 꼬리 4바이트 = 메타데이터 길이 (suffix라 전체 크기를 몰라도 된다)
      const tail = await download({ suffix: ROFL_TAIL_SIZE_BYTES });
      if (tail.statusCode !== 206) {
        fullBuffer = tail.buffer;
      } else if (tail.buffer.length < ROFL_TAIL_SIZE_BYTES) {
        fullBuffer = tail.buffer;
      } else if (tail.buffer.length === ROFL_TAIL_SIZE_BYTES) {
        const metaLength = tail.buffer.readUInt32LE(0);

        if (metaLength > 0 && metaLength <= ROFL_METADATA_MAX_BYTES) {
          // 3. 끝에서 metaLength+4 바이트를 받아 길이 필드 4바이트를 떼면 메타데이터 본문
          const metaRes = await download({ suffix: metaLength + ROFL_TAIL_SIZE_BYTES });
          if (metaRes.statusCode !== 206) {
            fullBuffer = metaRes.buffer;
          } else if (metaRes.buffer.length < metaLength + ROFL_TAIL_SIZE_BYTES) {
            fullBuffer = metaRes.buffer;
          } else if (metaRes.buffer.length === metaLength + ROFL_TAIL_SIZE_BYTES) {
            try {
              return {
                rawData: this.parseStatsString(
                  metaRes.buffer.subarray(0, metaLength).toString('utf-8'),
                ),
                patchVersion: this.parsePatchVersion(header.buffer),
              };
            } catch {
              // 메타 구간이 파싱되지 않는 파일 — 전체 수신 후 기존 경로로 폴백
            }
          }
        }
      }
    }

    // 폴백: 전체 파일 기준 기존 파싱 (전체를 이미 받았으면 그 버퍼를 재사용)
    const buffer = fullBuffer ?? (await download()).buffer;
    const parsed = await this.parseReplayData(buffer);
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
