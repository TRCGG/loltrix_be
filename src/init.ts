import { initializeDB } from './database/connectionPool';

export const initConnectionPool = async (): Promise<boolean> => {
  return await initializeDB();
};
