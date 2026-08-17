-- guild_member (guild_id, account) unique 신설 (TRC-266).
-- insertGuildMember는 select-then-insert라 동시 업로드 두 건이 같은 (길드, 계정)을
-- 넣으면 서로를 못 보고 중복 행이 들어간다. 이 인덱스가 최종 방어선이며,
-- 서비스 코드의 ON CONFLICT target이 이를 참조한다.
-- 주의: 이 인덱스 없이 서비스 코드만 배포하면 insert가 "no unique constraint matching
-- ON CONFLICT" 에러를 낸다. 반드시 코드 배포 전에 적용해야 한다.

-- 1) 기존 중복 확인 (적용 전 수동 실행):
--    SELECT guild_id, account, count(*)
--    FROM guild_member GROUP BY guild_id, account HAVING count(*) > 1;
--    결과가 있으면 아래 DELETE가 id가 큰(나중에 생긴) 행을 지운다.
--    중복 행끼리 main_account·status 값이 다르면 어느 쪽을 남길지 수동 판단 후 진행한다.
DELETE FROM guild_member a
USING guild_member b
WHERE a.guild_id = b.guild_id
  AND a.account = b.account
  AND a.id > b.id;

-- 2) unique 인덱스 (제약 대신 인덱스 — IF NOT EXISTS로 재실행 안전)
CREATE UNIQUE INDEX IF NOT EXISTS uq_guild_member_guild_account
ON guild_member (guild_id, account);
