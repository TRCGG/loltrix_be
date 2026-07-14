import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { tournamentService } from '../services/tournament.service.js';
import { getMatch } from '../clients/riot/index.js';
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
  // 1. 시크릿 검증. 불일치 시 next()로 넘겨 notFoundHandler의 404로 위장한다(실경로 존재 은닉).
  const expected = process.env.RIOT_CALLBACK_SECRET;
  if (!expected || !secretEquals(req.params.secret, expected)) {
    return next();
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

    // 3. matchId 조립 후 match-v5 재조회.
    const matchId = `${region}_${gameId}`;
    const matchV5 = await getMatch(matchId);

    // 4. info.tournamentCode가 DB 코드와 일치할 때만 인정.
    if (matchV5.info?.tournamentCode !== shortCode) {
      return res.status(200).json({ status: 'ignored', reason: 'tournament_code_mismatch' });
    }

    // 검증 통과 — 코드 COMPLETED 전이 + used_date 갱신.
    await tournamentService.markCompleted(shortCode);

    // TODO(TRC-225 단계5): tournamentSave.facade 적재 호출.
    //   검증된 match-v5 응답(matchV5)과 코드 컨텍스트(pending)를 넘겨 정규화 적재한다.
    //   현재는 검증·상태 전이까지만 수행하고 적재 인터페이스만 남긴다.
    void matchV5;

    return res.status(200).json({ status: 'ok', matchId });
  } catch (error) {
    return next(error);
  }
};
