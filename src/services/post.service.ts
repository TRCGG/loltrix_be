import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { discordMember, post } from '../database/schema.js';
import { imageUploadService } from './imageUpload.service.js';
import {
  AdminPostDetail,
  AdminPostListItem,
  AdminPostWriteResult,
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

const adminDetailColumns = {
  ...detailFields,
  isPublished: post.isPublished,
  createDate: post.createDate,
};

const adminDetailFields = { ...adminDetailColumns, authorName: discordMember.displayName };

const listFields = (category: PostCategory | undefined, admin: boolean) => ({
  id: post.id,
  category: post.category,
  title: post.title,
  sortOrder: post.sortOrder,
  publishDate: post.publishDate,
  ...(category && LIST_WITH_CONTENT_CATEGORIES.includes(category) ? { content: post.content } : {}),
  ...(admin
    ? {
        isPublished: post.isPublished,
        updateDate: post.updateDate,
        authorName: discordMember.displayName,
      }
    : {}),
});

const authorJoin = eq(discordMember.id, post.authorId);

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
  /**
   * @desc 공개된 글 목록 조회 (페이지네이션)
   */
  public async listPublished(query: PostListQuery) {
    return this.findPage<PostListItem>(query, false);
  }

  /**
   * @desc 관리용 글 목록 조회 (초안 포함, 작성자 표시명 포함)
   */
  public async listForAdmin(query: PostListQuery) {
    return this.findPage<AdminPostListItem>(query, true);
  }

  /**
   * @desc 공개된 글 상세 조회. 초안·삭제 글은 null
   */
  public async getPublished(id: number): Promise<PostDetail | null> {
    const [row] = await db
      .select(detailFields)
      .from(post)
      .where(and(activeById(id), eq(post.isPublished, true)));
    return row ?? null;
  }

  /**
   * @desc 관리용 글 상세 조회 (초안 포함, 작성자 표시명 포함). 삭제 글은 null
   */
  public async getForAdmin(id: number): Promise<AdminPostDetail | null> {
    const [row] = await db
      .select(adminDetailFields)
      .from(post)
      .leftJoin(discordMember, authorJoin)
      .where(activeById(id));
    return row ?? null;
  }

  /**
   * @desc 글 작성
   */
  public async create(input: PostCreateInput, authorId: string): Promise<AdminPostWriteResult> {
    // 저장보다 먼저 확정한다. 저장 뒤에 실패하면 이미지가 수명 주기 규칙에 지워져 글이 깨진다.
    await imageUploadService.confirmImages(input.content);
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
      .returning(adminDetailColumns);
    return row;
  }

  /**
   * @desc 글 수정·공개 전환. 없거나 삭제된 글이면 null
   */
  public async update(id: number, input: PostUpdateInput): Promise<AdminPostWriteResult | null> {
    if (input.content !== undefined) await imageUploadService.confirmImages(input.content);
    const [row] = await db
      .update(post)
      .set({
        ...input,
        // 처음 공개할 때만 찍는다. 공개를 내렸다 다시 올려도 목록 순서가 그대로여야 한다.
        ...(input.isPublished ? { publishDate: sql`COALESCE(${post.publishDate}, NOW())` } : {}),
      })
      .where(activeById(id))
      .returning(adminDetailColumns);
    return row ?? null;
  }

  /**
   * @desc 글 논리적 삭제. 없거나 이미 삭제된 글이면 false
   */
  public async remove(id: number): Promise<boolean> {
    const rows = await db
      .update(post)
      .set({ isDeleted: true })
      .where(activeById(id))
      .returning({ id: post.id });
    return rows.length > 0;
  }

  /**
   * @desc 목록 한 페이지와 전체 개수 조회. admin이면 초안을 포함하고 작성자 표시명을 조인한다
   */
  private async findPage<T>({ category, page, limit }: PostListQuery, admin: boolean) {
    const where = and(
      eq(post.isDeleted, false),
      admin ? undefined : eq(post.isPublished, true),
      category ? eq(post.category, category) : undefined,
    );

    const base = db.select(listFields(category, admin)).from(post);
    const items = (await (admin ? base.leftJoin(discordMember, authorJoin) : base)
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
