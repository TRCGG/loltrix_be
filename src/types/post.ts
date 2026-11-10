export const POST_CATEGORIES = ['devlog', 'faq', 'guide', 'etc'] as const;

export type PostCategory = (typeof POST_CATEGORIES)[number];

/** 직접 정한 순서(sort_order)로 보여 주는 카테고리. 나머지는 처음 공개한 시각 최신순. */
export const SORT_ORDER_CATEGORIES: readonly PostCategory[] = ['faq', 'guide'];

/** 펼쳐 보는 형태라 목록에 본문까지 담는 카테고리. */
export const LIST_WITH_CONTENT_CATEGORIES: readonly PostCategory[] = ['faq'];

export const POST_TITLE_MAX = 200;
export const POST_CONTENT_MAX = 10_000;

export interface PostListQuery {
  category?: PostCategory;
  page: number;
  limit: number;
}

export interface PostListItem {
  id: number;
  category: string;
  title: string;
  content?: string;
  sortOrder: number | null;
  publishDate: Date | null;
}

export interface AdminPostListItem extends PostListItem {
  isPublished: boolean;
  updateDate: Date;
}

export interface PostDetail {
  id: number;
  category: string;
  title: string;
  content: string;
  sortOrder: number | null;
  publishDate: Date | null;
  updateDate: Date;
}

export interface AdminPostDetail extends PostDetail {
  isPublished: boolean;
  createDate: Date;
}

export interface PostCreateInput {
  category: PostCategory;
  title: string;
  content: string;
  isPublished?: boolean;
  sortOrder?: number | null;
}

export type PostUpdateInput = Partial<PostCreateInput>;

export interface PostResponse<T> {
  status: 'success' | 'error';
  message: string;
  data: T | null;
}
