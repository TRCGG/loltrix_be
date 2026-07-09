import { eq } from 'drizzle-orm';
import { db, DbOrTx } from '../database/connectionPool.js';
import { systemConfig } from '../database/schema.js';

export class SystemConfigService {
  /**
   * @desc 단일 설정값 조회
   * @param executor 트랜잭션 안에서 호출 시 tx를 넘겨 별도 풀 커넥션을 잡지 않게 한다.
   */
  public async getConfig(key: string, executor: DbOrTx = db): Promise<string | null> {
    const result = await executor
      .select({ value: systemConfig.value })
      .from(systemConfig)
      .where(eq(systemConfig.key, key))
      .limit(1);

    return result[0]?.value ?? null;
  }

  /**
   * @desc 단일 설정값 조회 (없으면 기본값 반환)
   */
  public async getConfigOrDefault(
    key: string,
    defaultValue: string,
    executor: DbOrTx = db,
  ): Promise<string> {
    const value = await this.getConfig(key, executor);
    return value ?? defaultValue;
  }

  /**
   * @desc 숫자 설정값 조회
   */
  public async getNumberConfig(
    key: string,
    defaultValue: number,
    executor: DbOrTx = db,
  ): Promise<number> {
    const value = await this.getConfig(key, executor);
    return value ? Number(value) : defaultValue;
  }

  /**
   * @desc 쉼표 구분 설정값을 배열로 조회
   */
  public async getListConfig(key: string, executor: DbOrTx = db): Promise<string[]> {
    const value = await this.getConfig(key, executor);
    return value ? value.split(',').map((v) => v.trim()) : [];
  }

  /**
   * @desc 전체 설정값 조회
   */
  public async getAllConfigs(): Promise<Record<string, string>> {
    const results = await db.select().from(systemConfig);
    const configMap: Record<string, string> = {};
    for (const row of results) {
      configMap[row.key] = row.value;
    }
    return configMap;
  }
}

export const systemConfigService = new SystemConfigService();
