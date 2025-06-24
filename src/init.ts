import { testConnection } from './database/connectionPool';

export const initConnectionPool = async (): Promise<boolean> => {
  return await testConnection();
};
