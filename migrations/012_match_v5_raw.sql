-- Match-V5 원본 보존 테이블 (TRC-225 후속 — 대회 경기 전체 데이터 확보).
-- 어댑터가 리플 rawData 형태로 정규화하며 버리는 필드(challenges·핑·팀 오브젝트 등)를
-- 잃지 않도록 match-v5 응답 전체를 jsonb로 보존한다 (replay.raw_data 패턴).
-- timeline_json은 별도 API 호출이라 실패 시 NULL 허용(적재를 막지 않음, 추후 backfill 가능).
-- source: 적재 출처 구분 — 현재 TOURNAMENT(대회), 추후 일반내전 등 확장 대비.

CREATE TABLE IF NOT EXISTS match_v5_raw (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  custom_match_id VARCHAR(255) NOT NULL REFERENCES custom_match (id),
  guild_id        VARCHAR(128) NOT NULL REFERENCES guild (id),
  source          VARCHAR(16)  NOT NULL DEFAULT 'TOURNAMENT',
  match_json      JSONB        NOT NULL,               -- match-v5 응답 원본 전체
  timeline_json   JSONB,                               -- match-v5 timeline 원본(조회 실패 시 NULL)
  create_date     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  update_date     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  is_deleted      BOOLEAN      NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_match_v5_raw_custom_match UNIQUE (custom_match_id)
);

-- 길드별 원본 조회.
CREATE INDEX IF NOT EXISTS idx_match_v5_raw_guild ON match_v5_raw (guild_id);
