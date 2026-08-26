-- replay_code 접미사 발급용 전용 시퀀스 (TRC-279).
-- 서비스 코드가 nextval('replay_code_seq')를 호출하므로 반드시 코드 배포 전에 적용한다.
-- 기존 접미사는 replay.id 기반이라 그 대역 바로 다음부터 발급되도록 setval 한다.
-- 재실행 안전: 마이그레이션과 앱 재시작 사이에 구 코드가 max(id)+1을 더 발급했을 수 있으므로
-- 배포 직전에 한 번 더 실행해도 된다 (last_value보다 낮아지지 않는다).

CREATE SEQUENCE IF NOT EXISTS replay_code_seq;

SELECT setval(
  'replay_code_seq',
  GREATEST(
    (SELECT COALESCE(MAX(id), 0) FROM replay) + 1,
    (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM replay_code_seq)
  ),
  false
);
