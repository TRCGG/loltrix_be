import { eq, and } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { message } from '../database/schema.js';

/**
 * @desc 특정 언어 코드와 키에 해당하는 메시지 조회
 */
export const getMessageByLocaleAndKey = async (languageCode: string, key: string) => {
  const result = await db
    .select()
    .from(message)
    .where(and(eq(message.languageCode, languageCode), eq(message.key, key), eq(message.isDeleted, false)))
    .limit(1);

  return result[0]?.value;
};