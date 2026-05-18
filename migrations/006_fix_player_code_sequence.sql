-- player_code를 id 기반 GENERATED에서 독립 시퀀스 DEFAULT로 변경
-- 배경: id 시퀀스 롤백 시 player_code에 갭이 발생하는 문제 수정

BEGIN;

-- 1. 독립 시퀀스 생성
CREATE SEQUENCE IF NOT EXISTS player_code_seq;

-- 2. 현재 player_code 최대값으로 시퀀스 초기화 (최솟값 1 보장)
SELECT setval(
  'player_code_seq',
  GREATEST(
    COALESCE(
      (SELECT MAX(CAST(SUBSTRING(player_code FROM 5) AS INTEGER)) FROM riot_account),
      0
    ),
    1
  )
);

-- 3. GENERATED 속성 제거 (GENERATED 컬럼인 경우에만 실행)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'riot_account'
      AND column_name = 'player_code'
      AND generation_expression IS NOT NULL
  ) THEN
    ALTER TABLE riot_account ALTER COLUMN player_code DROP EXPRESSION;
  END IF;
END $$;

-- 4. 독립 시퀀스를 사용하는 DEFAULT 설정
ALTER TABLE riot_account
  ALTER COLUMN player_code
  SET DEFAULT 'PLR_' || LPAD(NEXTVAL('player_code_seq')::TEXT, 6, '0');

COMMIT;
