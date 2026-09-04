-- 대회 상태를 모집중(RECRUITING)·진행중(IN_PROGRESS)·종료(CLOSED) 3단계로 나눈다.
-- 모집중 대회는 길드에 여러 개 둘 수 있고, 리플이 대회명 없이 자동으로 붙는 "진행중"만 하나로 제한된다.
--
-- 순서 주의 1: backfill이 인덱스 교체보다 먼저다. 새 코드에는 OPEN이 없어, OPEN으로 남은 행은
--   어떤 상태 조회에도 걸리지 않고 리플 태깅 대상에서 통째로 빠진다.
-- 순서 주의 2: 019와 앱 리로드 사이에는 어느 쪽을 먼저 해도 깨지는 구간이 있다. 트래픽이 없는
--   시간에 019를 돌리고 곧바로 앱을 리로드해 그 구간을 좁힌다.
--   019 먼저: 구 코드가 status='OPEN'으로 insert해 새 CHECK에 걸리고, OPEN을 찾는 !대회종료·리플 저장이 대상을 못 찾는다.
--   리로드 먼저: 새 코드가 IN_PROGRESS를 못 찾아 !대회종료·리플 저장이 전부 실패한다.
UPDATE competition SET status = 'IN_PROGRESS' WHERE status = 'OPEN';

DROP INDEX IF EXISTS uq_competition_guild_open;

CREATE UNIQUE INDEX IF NOT EXISTS uq_competition_guild_in_progress
  ON competition (guild_id) WHERE status = 'IN_PROGRESS';

-- false면 신청이 들어오는 즉시 APPROVED로 저장된다 (운영진 승인 단계를 건너뛰는 대회).
ALTER TABLE competition
  ADD COLUMN IF NOT EXISTS approval_required BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE competition
  ALTER COLUMN status SET DEFAULT 'RECRUITING';

ALTER TABLE competition
  DROP CONSTRAINT IF EXISTS ck_competition_status;
ALTER TABLE competition
  ADD CONSTRAINT ck_competition_status
  CHECK (status IN ('RECRUITING', 'IN_PROGRESS', 'CLOSED'));
