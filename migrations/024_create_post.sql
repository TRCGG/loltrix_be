-- 개발자 게시판. 카테고리는 CHECK로 묶지 않는다 — 카테고리 추가를 코드(types/post.ts) 수정만으로 끝내기 위해서.
-- publish_date는 처음 공개한 시각이다. 공개를 내렸다 다시 올려도 바꾸지 않아 목록 순서가 유지된다.
CREATE TABLE IF NOT EXISTS post (
  id            SERIAL        PRIMARY KEY,
  category      VARCHAR(16)   NOT NULL,
  title         VARCHAR(200)  NOT NULL,
  content       TEXT          NOT NULL,
  is_published  BOOLEAN       NOT NULL DEFAULT false,
  publish_date  TIMESTAMPTZ,
  sort_order    INTEGER,
  author_id     VARCHAR(64)   NOT NULL,
  create_date   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  update_date   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  is_deleted    BOOLEAN       NOT NULL DEFAULT false
);
