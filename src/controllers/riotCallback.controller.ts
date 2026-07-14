import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { tournamentService } from '../services/tournament.service.js';
import { tournamentSaveFacade } from '../facade/tournamentSave.facade.js';
import { notFoundHandler } from '../middlewares/notFoundHandler.js';
import { RiotTournamentCallbackPayload } from '../types/tournament.js';

/**
 * @desc 상수시간 비교. 길이 유출을 피하려 양쪽을 sha256으로 고정 길이화한 뒤 비교한다.
 */
function secretEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * @desc Riot 토너먼트 콜백 수신 (무인증 외부 호출 — 인증 체인보다 위에 등록).
 *
 * 보안 불변식(기획 §보안): 콜백 페이로드는 신뢰하지 않는다.
 *  1) 경로 시크릿을 RIOT_CALLBACK_SECRET과 상수시간 비교 — 불일치 시 404로 위장(엔드포인트 은닉).
 *  2) shortCode가 DB에 PENDING으로 존재하는지 확인.
 *  3) matchId = region + '_' + gameId 조립 → match-v5 조회.
 *  4) info.tournamentCode가 shortCode와 일치할 때만 인정 → COMPLETED 전이.
 *
 * @route POST /api/callback/riot/:secret
 */
export const handleRiotCallback = async (
  req: Request<{ secret: string }>,
  res: Response,
  next: NextFunction,
) => {
  // 1. 시크릿 검증. 불일치 시 notFoundHandler를 직접 호출해 진짜 미존재 경로와 동일한
  //    ProblemDetails 404로 위장한다(실경로 존재 은닉).
  //    ⚠️ `next()`로 넘기면 안 된다 — 이 라우트는 인증 체인보다 위에 있어 next()가
  //    라우터 스택의 다음 미들웨어(restrictBotToLocalhost, verifyAuth)로 흘러 401이 나간다.
  const expected = process.env.RIOT_CALLBACK_SECRET;
  if (!expected || !secretEquals(req.params.secret, expected)) {
    return notFoundHandler(req, res, next);
  }

  try {
    const payload = req.body as RiotTournamentCallbackPayload;
    const shortCode = payload.shortCode;
    const gameId = payload.gameId;
    const region = payload.region;

    if (!shortCode || gameId === undefined || gameId === null || !region) {
      // 페이로드 형식 불량 — 처리하지 않고 조용히 ack.
      return res.status(200).json({ status: 'ignored', reason: 'malformed_payload' });
    }

    // 2. DB에 PENDING 코드로 존재하는지 확인(페이로드 신뢰 금지).
    const pending = await tournamentService.findPendingByCode(shortCode);
    if (!pending) {
      return res.status(200).json({ status: 'ignored', reason: 'unknown_or_used_code' });
    }

    // 3. matchId 조립 후 파사드로 재검증·적재.
    //    match-v5 재조회 → info.tournamentCode 대조 → 단일 트랜잭션 적재 + COMPLETED 전이까지
    //    파사드가 담당한다(상태 전이가 적재 트랜잭션 안에 있어 적재 실패 시 PENDING 유지).
    const matchId = `${region}_${gameId}`;
    const result = await tournamentSaveFacade.ingestByMatchId(pending, matchId);

    if (result.status === 'ignored') {
      return res.status(200).json({ status: 'ignored', reason: result.reason });
    }

    return res.status(200).json({ status: 'ok', matchId, loaded: result.loaded });
  } catch (error) {
    return next(error);
  }
};
