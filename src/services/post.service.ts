import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { post } from '../database/schema.js';
import {
  AdminPostDetail,
  AdminPostListItem,
  LIST_WITH_CONTENT_CATEGORIES,
  PostCategory,
  PostCreateInput,
  PostDetail,
  PostListItem,
  PostListQuery,
  PostUpdateInput,
  SORT_ORDER_CATEGORIES,
} from '../types/post.js';

const detailFields = {
  id: post.id,
  category: post.category,
  title: post.title,
  content: post.content,
  sortOrder: post.sortOrder,
  publishDate: post.publishDate,
  updateDate: post.updateDate,
};

const adminDetailFields = {
  ...detailFields,
  isPublished: post.isPublished,
  createDate: post.createDate,
};

const listFields = (category: PostCategory | undefined, admin: boolean) => ({
  id: post.id,
  category: post.category,
  title: post.title,
  sortOrder: post.sortOrder,
  publishDate: post.publishDate,
  ...(category && LIST_WITH_CONTENT_CATEGORIES.includes(category) ? { content: post.content } : {}),
  ...(admin ? { isPublished: post.isPublished, updateDate: post.updateDate } : {}),
});

// 초안은 publish_date가 NULL이라 NULLS FIRST로 관리 목록 맨 위에 온다. 공개 목록에는 NULL이 없다.
const listOrder = (category: PostCategory | undefined) =>
  category && SORT_ORDER_CATEGORIES.includes(category)
    ? [sql`${post.sortOrder} ASC NULLS LAST`, asc(post.id)]
    : [sql`${post.publishDate} DESC NULLS FIRST`, desc(post.id)];

const activeById = (id: number) => and(eq(post.id, id), eq(post.isDeleted, false));

/**
 * @desc 개발자 게시판 서비스
 */
export class PostService {
  public async listPublished(query: PostListQuery) {
    return this.findPage<PostListItem>(query, false);
  }

  public async listForAdmin(query: PostListQuery) {
    return this.findPage<AdminPostListItem>(query, true);
  }

  public async getPublished(id: number): Promise<PostDetail | null> {
    const [row] = await db
      .select(detailFields)
      .from(post)
      .where(and(activeById(id), eq(post.isPublished, true)));
    return row ?? null;
  }

  public async getForAdmin(id: number): Promise<AdminPostDetail | null> {
    const [row] = await db.select(adminDetailFields).from(post).where(activeById(id));
    return row ?? null;
  }

  public async create(input: PostCreateInput, authorId: string): Promise<AdminPostDetail> {
    const [row] = await db
      .insert(post)
      .values({
        category: input.category,
        title: input.title,
        content: input.content,
        isPublished: input.isPublished ?? false,
        sortOrder: input.sortOrder ?? null,
        publishDate: input.isPublished ? sql`NOW()` : null,
        authorId,
      })
      .returning(adminDetailFields);
    return row;
  }

  public async update(id: number, input: PostUpdateInput): Promise<AdminPostDetail | null> {
    const [row] = await db
      .update(post)
      .set({
        ...input,
        // 처음 공개할 때만 찍는다. 공개를 내렸다 다시 올려도 목록 순서가 그대로여야 한다.
        ...(input.isPublished ? { publishDate: sql`COALESCE(${post.publishDate}, NOW())` } : {}),
      })
      .where(activeById(id))
      .returning(adminDetailFields);
    return row ?? null;
  }

  public async remove(id: number): Promise<boolean> {
    const rows = await db
      .update(post)
      .set({ isDeleted: true })
      .where(activeById(id))
      .returning({ id: post.id });
    return rows.length > 0;
  }

  private async findPage<T>({ category, page, limit }: PostListQuery, admin: boolean) {
    const where = and(
      eq(post.isDeleted, false),
      admin ? undefined : eq(post.isPublished, true),
      category ? eq(post.category, category) : undefined,
    );

    const items = (await db
      .select(listFields(category, admin))
      .from(post)
      .where(where)
      .orderBy(...listOrder(category))
      .limit(limit)
      .offset((page - 1) * limit)) as T[];

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::integer` })
      .from(post)
      .where(where);

    return { items, totalCount: countRow?.count ?? 0 };
  }
}

export const postService = new PostService();
