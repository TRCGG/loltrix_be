import { initializeDB } from './database/connectionPool.js';

export const initConnectionPool = async (): Promise<boolean> => {
  return initializeDB();
};
