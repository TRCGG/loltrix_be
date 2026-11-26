import { schedule } from 'node-cron';
import { closeDB, initializeDB } from '../database/connectionPool.js';
import { systemConfigService } from '../services/systemConfig.service.js';
import { runMmrBatch, seedMmrBatchWatermark } from '../services/mmr/mmrBatch.service.js';

/**
 * MMR 일일 배치. API와 분리된 프로세스로 띄운다(PM2 앱 gmok-mmr-batch).
 *
 *   node dist/jobs/mmrBatch.cli.js                                   매일 12:00 KST에 실행(상주)
 *   node dist/jobs/mmrBatch.cli.js --once                            지금 한 번 실행하고 종료
 *   node dist/jobs/mmrBatch.cli.js --seed=2026-12-01T06:00:00+09:00  서비스 시작 때 한 번
 *
 * --seed 값은 데이터팀 전체 계산이 자른 06:00 KST 컷오프다(그 이후 경기는 배치가 계산한다).
 * system_config MMR_BATCH_ENABLED=1일 때만 계산한다 — 서버 설정을 건드리지 않고 끄고 켜기 위해서.
 */

// 시간대를 코드에 고정한다 — PM2 cron_restart·crontab은 서버 시간대를 따라 서버마다 시각이 달라진다.
const SCHEDULE = '0 12 * * *';
const SCHEDULE_TIMEZONE = 'Asia/Seoul';

const runOnce = async (): Promise<void> => {
  const enabled = await systemConfigService.getNumberConfig('MMR_BATCH_ENABLED', 0);
  if (enabled !== 1) {
    console.log('[mmrBatch] MMR_BATCH_ENABLED is off — skipped');
    return;
  }

  const report = await runMmrBatch();
  console.log(
    `[mmrBatch] ${report.status} ${report.cutoffFrom.toISOString()} ~ ${report.cutoffTo.toISOString()} ` +
      `guildSeasons=${report.guildSeasons} matches=${report.processedMatches} skipped=${report.skippedMatches.length}`,
  );
  for (const skipped of report.skippedMatches) {
    console.warn(`[mmrBatch] skipped ${skipped.guildId}/${skipped.replayCode}: ${skipped.reason}`);
  }
};

const runAndExit = async (job: () => Promise<void>): Promise<never> => {
  try {
    await job();
    await closeDB();
    process.exit(0);
  } catch (error) {
    console.error('[mmrBatch] failed', error);
    await closeDB().catch(() => undefined);
    process.exit(1);
  }
};

const main = async (): Promise<void> => {
  if (!(await initializeDB())) throw new Error('database connection failed');

  const seedArg = process.argv.find((arg) => arg.startsWith('--seed'));
  if (seedArg) {
    await runAndExit(async () => {
      const cutoff = new Date(seedArg.slice('--seed='.length));
      if (Number.isNaN(cutoff.getTime())) {
        throw new Error('usage: --seed=<06:00 KST cutoff, e.g. 2026-12-01T06:00:00+09:00>');
      }
      const watermark = await seedMmrBatchWatermark(cutoff);
      console.log(`[mmrBatch] seeded watermark ${watermark.toISOString()}`);
    });
  }

  if (process.argv.includes('--once')) {
    await runAndExit(runOnce);
  }

  schedule(
    SCHEDULE,
    async () => {
      try {
        await runOnce();
      } catch (error) {
        // 실패한 구간은 컷오프가 기록되지 않아 다음 날 실행이 이어서 처리한다.
        console.error('[mmrBatch] failed', error);
      }
    },
    { name: 'mmr-batch', timezone: SCHEDULE_TIMEZONE, noOverlap: true },
  );
  console.log(`[mmrBatch] scheduler started (cron='${SCHEDULE}' ${SCHEDULE_TIMEZONE})`);
};

main().catch(async (error) => {
  console.error('[mmrBatch] failed to start', error);
  await closeDB().catch(() => undefined);
  process.exit(1);
});
