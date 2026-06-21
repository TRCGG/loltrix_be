-- 상대전적 API 조회 성능 개선용 인덱스.
-- src/services/encounter.service.ts의 조회 조건에 맞춰 설계했습니다.

-- getEncounterRawGames, getFrequentOpponents에서 사용합니다.
-- match_participant 셀프 조인은 player_code로 대상 유저의 경기 목록을 찾고,
-- custom_match_id로 같은 경기의 다른 참가자와 조인합니다.
-- 상대전적 조회는 항상 삭제되지 않은 참가자만 보므로 partial index로 구성했습니다.
CREATE INDEX IF NOT EXISTS idx_match_participant_active_player_match
ON match_participant (player_code, custom_match_id)
WHERE is_deleted = false;

-- match_participant에서 custom_match로 조인한 뒤 사용합니다.
-- summary/games 조회는 guild_id + season으로 필터링하고 create_date DESC로 정렬합니다.
-- id는 조인 키라서 같은 인덱스에서 함께 사용할 수 있도록 마지막에 포함했습니다.
CREATE INDEX IF NOT EXISTS idx_custom_match_active_guild_season_created
ON custom_match (guild_id, season, create_date DESC, id)
WHERE is_deleted = false;

-- getFrequentOpponents에서 사용합니다.
-- 자주 만난 상대가 해당 길드의 활성 메인 멤버인지 확인하는 조인에 맞춘 인덱스입니다.
-- is_main/status/is_deleted는 쿼리에서 고정으로 거는 조건이라 partial index 조건으로 뺐습니다.
CREATE INDEX IF NOT EXISTS idx_guild_member_active_account_guild
ON guild_member (account, guild_id)
WHERE is_main = true
  AND status = '1'
  AND is_deleted = false;
