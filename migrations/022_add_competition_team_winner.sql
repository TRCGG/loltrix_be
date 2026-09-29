-- 우승팀은 기존 로스터 팀 중 대회당 최대 한 팀. 기본값 false로 기존 팀은 미지정 상태를 유지한다.
BEGIN;

ALTER TABLE competition_team
  ADD COLUMN IF NOT EXISTS is_winner BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_competition_team_winner
  ON competition_team (competition_id) WHERE is_winner = true;

COMMIT;
