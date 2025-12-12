// types/statistics.ts

import { MatchStats } from './matchParticipant.js';

// 유저별 게임 통계 결과 (기본 통계 + 유저 정보)
export interface UserGameStatistic extends MatchStats {
  riotName: string;
  riotNameTag: string;
  position?: string;
}

export interface ChampionStatistic extends MatchStats {
  champName: string;
  champNameEng: string;
  position?: string;
}

// API 응답 타입
export interface StatisticsResponse<T> {
  status: 'success' | 'error';
  message: string;
  data: T | T[] | null;
}

// 쿼리 파라미터
export interface GetStatisticsQuery {
  year?: string;
  month?: string;
  championName?: string;
  position?: string;
  page?: string;
  season?: string;
  limit?: string;
  sortBy?: 'totalCount' | 'winRate';
}
