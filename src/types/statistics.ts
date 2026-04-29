// types/statistics.ts

import { MatchStats } from './matchParticipant.js';

// 통계 조회 방식
export type StatisticsDatePreset = 'recent' | 'season' | 'range';

// 유저별 게임 통계 결과 타입
export interface UserGameStatistic extends MatchStats {
  riotName: string;
  riotNameTag: string;
  position?: string;
}

// 챔피언별 게임 통계 결과 타입
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

// 컨트롤러에서 req.query로 받는 요청 원본 타입
// 쿼리스트링 특성상 page, limit을 포함한 값들이 문자열로 들어온다.
export interface StatisticsRequestQuery {
  datePreset?: StatisticsDatePreset;
  fromMonth?: string;
  toMonth?: string;
  championName?: string;
  position?: string;
  page?: string;
  season?: string;
  limit?: string;
  sortBy?: 'totalCount' | 'winRate';
}

// 서비스 계층으로 전달하는 가공된 조회 옵션 타입
// 컨트롤러에서 기본값 적용과 숫자 변환을 마친 뒤 이 타입으로 넘긴다.
export interface StatisticsServiceOptions
  extends Pick<
    StatisticsRequestQuery,
    'datePreset' | 'fromMonth' | 'toMonth' | 'championName' | 'position' | 'season'
  > {
  sortBy?: 'totalCount' | 'winRate';
  page?: number;
  limit?: number;
}
