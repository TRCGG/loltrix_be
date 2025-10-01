import { eq, and } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { message } from '../database/schema.js';
import { LRUCache } from 'lru-cache';

/**
 * @desc 다국어 메시지 조회 및 캐싱을 관리
 */
export class MessageService {
  private cache: LRUCache<string, string>;

  constructor() {
    this.cache = new LRUCache<string, string>({
      max: 500, // 최대 500개의 항목을 캐시
      ttl: 1000 * 60 * 5, // 5분 동안 유효
    });
  }

  /**
   * @desc 특정 언어 코드와 키에 해당하는 메시지를 조회
   * 캐시를 먼저 확인하고, 없으면 DB에서 조회 후 캐시에 저장
   */
  public async getMessage(
    languageCode: string,
    key: string,
  ): Promise<string | undefined> {
    const cacheKey = `${languageCode}:${key}`;
    let value = this.cache.get(cacheKey);

    // 1. 캐시 히트 (Cache Hit)
    if (value) {
      return value;
    }

    // 2. 캐시 미스 (Cache Miss) -> DB 조회
    const result = await db
      .select({ value: message.value }) 
      .from(message)
      .where(
        and(
          eq(message.languageCode, languageCode),
          eq(message.key, key),
          eq(message.isDeleted, false),
        ),
      )
      .limit(1);

    value = result[0]?.value;

    if (value) {
      this.cache.set(cacheKey, value);
      return value;
    }
    throw new Error("message error while get Message")
  }
}

export const messageService = new MessageService();
