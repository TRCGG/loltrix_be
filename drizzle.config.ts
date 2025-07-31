import { defineConfig } from 'drizzle-kit';
import dotenv from 'dotenv';

// Load environment-specific .env file
const nodeEnv = process.env.NODE_ENV || 'development';
const envFile = `.env.${nodeEnv}`;
dotenv.config({ path: envFile });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema.ts',
  out: './drizzle',
  dbCredentials: {
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_NAME!,
    ssl: process.env.DB_SSL === 'true' ? {
      rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
    } : false,
  },
});