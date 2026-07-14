import { schedule, validate, type ScheduledTask } from 'node-cron';
import { getGamesByCode } from '../clients/riot/index.js';
import { tournamentService } from '../services/tournament.service.js';
import { tournamentSaveFacade } from '../facade/tournamentSave.facade.js';

/**
 * @desc 폴백 폴링 잡 (node-cron 인프로세스).
 *
 * stub는 콜백이 오지 않고, 실 운영에서도 콜백이 유실될 수 있다. 이를 대비해 주기적으로
 * "PENDING이고 발급된 지 충분히 지난" 코드를 games/by-code로 조회하고, 경기가 잡혔으면
 * matchId를 조립해 **콜백과 동일한 검증·적재 경로(tournamentSaveFacade.ingestByMatchId)**로 회수한다.
 *
 * env:
 *  - TOURNAMENT_POLL_CRON: cron 식(기본 '*​/10 * * * *' — 10분마다)
 *  - TOURNAMENT_POLL_MIN_AGE_HOURS: 이 시간 이상 지난 PENDING만 대상(기본 1)
 *  - RIOT_TOURNAMENT_REGION: matchId 조립 시 게임 응답에 region이 없을 때 폴백(기본 KR)
 */

const DEFAULT_CRON = '*/10 * * * *';
const DEFAULT_MIN_AGE_HOURS = 1;

let task: ScheduledTask | null = null;

/** env에서 PENDING 최소 경과 시간(시간). 잘못된 값이면 기본값. */
function getMinAgeHours(): number {
  const raw = process.env.TOURNAMENT_POLL_MIN_AGE_HOURS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_AGE_HOURS;
}

/**
 * @desc 폴링 1회 실행. 스케줄러와 수동/테스트 실행이 공유한다.
 */
export async function runTournamentPollingOnce(): Promise<void> {
  const minAgeHours = getMinAgeHours();
  const olderThan = new Date(Date.now() - minAgeHours * 60 * 60 * 1000);
  const fallbackRegion = process.env.RIOT_TOURNAMENT_REGION || 'KR';

  const dueCodes = await tournamentService.findDuePendingCodes(olderThan);
  if (dueCodes.length === 0) return;

  console.log(`[tournamentPolling] PENDING ${dueCodes.length}건 폴링 시작(경과 ${minAgeHours}h+).`);

  for (const codeRow of dueCodes) {
    try {
      const games = await getGamesByCode(codeRow.code);
      const game = (games ?? []).find((g) => g.gameId !== undefined && g.gameId !== null);
      if (!game || game.gameId === undefined || game.gameId === null) {
        // 아직 경기가 잡히지 않음 — 다음 주기에 재시도.
        continue;
      }

      const region = game.region || fallbackRegion;
      const matchId = `${region}_${game.gameId}`;

      const result = await tournamentSaveFacade.ingestByMatchId(codeRow, matchId);
      if (result.status === 'ok') {
        console.log(
          `[tournamentPolling] 회수 완료 code=${codeRow.code} matchId=${matchId} loaded=${result.loaded}`,
        );
      } else {
        console.warn(
          `[tournamentPolling] 회수 무시 code=${codeRow.code} matchId=${matchId} reason=${result.reason}`,
        );
      }
    } catch (error) {
      // 한 코드 실패가 나머지를 막지 않도록 개별 격리. 코드는 PENDING으로 남아 다음 주기 재시도.
      console.error(`[tournamentPolling] code=${codeRow.code} 처리 실패`, error);
    }
  }
}

/**
 * @desc 폴링 스케줄러 기동. 서버 부팅 시 1회 호출.
 * (RIOT_API_KEY 미설정 시 호출 자체를 하지 않는 것은 호출부(index.ts) 책임.)
 */
export function startTournamentPolling(): void {
  if (task) return; // 중복 기동 방지.

  const cronExpr = process.env.TOURNAMENT_POLL_CRON || DEFAULT_CRON;
  if (!validate(cronExpr)) {
    console.warn(
      `[tournamentPolling] 잘못된 TOURNAMENT_POLL_CRON='${cronExpr}' — 기본값 '${DEFAULT_CRON}' 사용.`,
    );
  }
  const effectiveCron = validate(cronExpr) ? cronExpr : DEFAULT_CRON;

  task = schedule(
    effectiveCron,
    async () => {
      try {
        await runTournamentPollingOnce();
      } catch (error) {
        console.error('[tournamentPolling] 폴링 주기 실행 실패', error);
      }
    },
    { name: 'tournament-polling', noOverlap: true },
  );

  console.log(`[tournamentPolling] 스케줄러 기동 (cron='${effectiveCron}').`);
}
