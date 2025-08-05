import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import dotenv from 'dotenv';
import * as schema from './schema.js';

// Load environment-specific .env file
const nodeEnv = process.env.NODE_ENV || 'development';
const envFile = `.env.${nodeEnv}`;
dotenv.config({ path: envFile });

class DatabaseConnectionPool {
  private static instance: DatabaseConnectionPool;

  private pool: Pool;

  private db: NodePgDatabase<typeof schema>;

  private isInitialized = false;

  private constructor() {
    const sslConfig =
      process.env.DB_SSL === 'true'
        ? {
            rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
          }
        : false;

    this.pool = new Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      // ssl: sslConfig,
      ssl: {
          rejectUnauthorized: false,
      },
      max: parseInt(process.env.DB_MAX_CONNECTIONS || '20', 10),
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '2000', 10),
    });

    this.pool.on('error', (err: Error) => {
      console.error('Unexpected error on idle client', err);
      process.exit(-1);
    });

    this.db = drizzle(this.pool, { schema });
  }

  public static getInstance(): DatabaseConnectionPool {
    if (!DatabaseConnectionPool.instance) {
      DatabaseConnectionPool.instance = new DatabaseConnectionPool();
    }
    return DatabaseConnectionPool.instance;
  }

  public getDB(): NodePgDatabase<typeof schema> {
    return this.db;
  }

  public getPool(): Pool {
    return this.pool;
  }

  public async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  public async testConnection(): Promise<boolean> {
    try {
      const result = await this.pool.query('SELECT NOW()');
      console.log('Database connection successful:', result.rows[0]);
      this.isInitialized = true;
      return true;
    } catch (error) {
      console.error('Database connection failed:', error);
      return false;
    }
  }

  public async initialize(): Promise<boolean> {
    if (this.isInitialized) {
      return true;
    }
    return this.testConnection();
  }

  public async close(): Promise<void> {
    await this.pool.end();
    this.isInitialized = false;
  }

  public isReady(): boolean {
    return this.isInitialized;
  }
}

// 싱글톤 인스턴스 export
export const dbConnectionPool = DatabaseConnectionPool.getInstance();

// 편의를 위한 alias exports
export const db = dbConnectionPool.getDB();
export const getPool = () => dbConnectionPool.getPool();
export const getClient = () => dbConnectionPool.getClient();
export const testConnection = () => dbConnectionPool.testConnection();
export const initializeDB = () => dbConnectionPool.initialize();
export const closeDB = () => dbConnectionPool.close();
export const isDBReady = () => dbConnectionPool.isReady();
