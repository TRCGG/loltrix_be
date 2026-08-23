import querystring from 'querystring';
import { eq, sql, and, isNull, gt } from 'drizzle-orm';
import { db, TransactionType } from '../database/connectionPool.js';
import { discordMember, discordToken, authSession } from '../database/schema.js';
import {
  InsertDiscordMember,
  InsertDiscordToken,
  InsertAuthSession,
  DiscordToken,
  DiscordTokenAPI,
} from '../types/discordAuth.js';
import { BusinessError, SystemError } from '../types/error.js';
import { fetchWithTimeout } from '../utils/fetchWithTimeout.js';
import { systemConfigService } from './systemConfig.service.js';

const discordApiBaseUrl = 'https://discord.com/api';
const clientId = process.env.DISCORD_CLIENT_ID;
const clientSecret = process.env.DISCORD_CLIENT_SECRET;
const redirectUri = process.env.DISCORD_REDIRECT_URI;
const DEFAULT_SESSION_MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000;

interface DiscordUserAPI {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

/** Discord는 avatar를 해시로 준다. 응답·저장 형식을 완성 URL 하나로 통일한다. */
function buildAvatarUrl(userId: string, avatarHash: string | null): string | null {
  return avatarHash ? `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png` : null;
}

function toProfile(userData: DiscordUserAPI) {
  return {
    id: userData.id,
    username: userData.username,
    global_name: userData.global_name,
    avatar: buildAvatarUrl(userData.id, userData.avatar),
  };
}

type DiscordProfile = ReturnType<typeof toProfile>;

// 값이 아니라 in-flight promise를 캐시해 동시 요청이 하나의 외부 호출을 공유하게 한다
// (캐시 스탬피드 방지).
// - /users/@me 호출은 액세스 토큰 유효성 확인을 겸한다. 캐시는 그 확인을 TTL만큼 늦출 뿐이지만,
//   호출을 DB(discord_member) 조회로 대체하면 확인이 영구히 사라진다.
// - 디스코드에서 프사·닉네임을 바꾸면 최대 TTL만큼 옛 값이 나간다. 로그인 콜백이 캐시를 최신값으로
//   덮고 로그아웃이 비우므로 재로그인이 즉시 회복 경로다.
// - TTL을 system_config로 빼지 않는다. systemConfigService에는 캐시가 없어 조회 한 번이 DB 쿼리
//   한 번이라, 아끼려던 비용을 요청마다 도로 쓴다.
// - 프로세스 로컬 캐시(공유 아님). 인스턴스가 여러 개면 인스턴스별로 존재한다.
const PROFILE_TTL_MS = 60 * 60 * 1000;
const profileCache = new Map<string, { promise: Promise<DiscordProfile>; expiresAt: number }>();

function cacheProfile(discordMemberId: string, promise: Promise<DiscordProfile>): void {
  // 만료 항목이 쌓이지 않도록 커지면 한 번 훑어 정리 (프로세스 로컬, 경량)
  if (profileCache.size > 1000) {
    const now = Date.now();
    profileCache.forEach((value, key) => {
      if (value.expiresAt <= now) profileCache.delete(key);
    });
  }

  const entry = { promise, expiresAt: Date.now() + PROFILE_TTL_MS };
  profileCache.set(discordMemberId, entry);

  // 실패는 캐시하지 않는다. 이 catch가 없으면 캐시에만 남고 아무도 await하지 않는 rejected
  // promise가 unhandled rejection으로 프로세스를 죽인다. 그 사이 새 항목이 들어왔으면 건드리지
  // 않도록 동일 entry일 때만 삭제.
  promise.catch(() => {
    if (profileCache.get(discordMemberId) === entry) profileCache.delete(discordMemberId);
  });
}

async function requestDiscordUser(accessToken: string): Promise<DiscordProfile> {
  try {
    const userResult = await fetchWithTimeout(`${discordApiBaseUrl}/users/@me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!userResult.ok) {
      throw new SystemError('Failed to fetch discord user', 500);
    }

    return toProfile(await userResult.json());
  } catch (error) {
    console.error('fetchUser service error', error);
    if (error instanceof SystemError) throw error;
    throw new SystemError('Failed to get user info', 500);
  }
}

/**
 * @desc 최초 로그인 시 토큰 포맷
 */
function formatNewToken(tokenData: DiscordTokenAPI) {
  return {
    accessToken: tokenData.access_token,
    acExpiresDate: new Date(Date.now() + tokenData.expires_in * 1000),
    refreshToken: tokenData.refresh_token,
    reExpiresDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    scope: tokenData.scope,
    tokenType: tokenData.token_type,
  };
}

/**
 * @desc 토큰 재발급 시 토큰 포맷 (토큰 순환 처리)
 */
function formatRefreshedToken(tokenData: DiscordTokenAPI, oldRefreshToken: string) {
  return {
    accessToken: tokenData.access_token,
    acExpiresDate: new Date(Date.now() + tokenData.expires_in * 1000),
    refreshToken: tokenData.refresh_token || oldRefreshToken,
    reExpiresDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    scope: tokenData.scope,
    tokenType: tokenData.token_type,
    rotatedDate: new Date(),
    revokedDate: null, // 재발급 시 폐기 상태 해제
  };
}

/**
 * @desc discord API 호출 및 DB 작업 처리
 */
export class DiscordAuthService {
  // --- 1. Public Methods (컨트롤러에서 호출) ---

  /**
   * @desc Discord OAuth2 인증 URL 생성 (로그인용)
   */
  public async getDiscordAuthorizeUrl(): Promise<string> {
    try {
      const scopes = await systemConfigService.getListConfig('DISCORD_OAUTH_SCOPES');
      const scopeStr = scopes.length > 0 ? scopes.join(' ') : 'identify guilds guilds.members.read';
      const authorizeUrl = `${discordApiBaseUrl}/oauth2/authorize?${querystring.stringify({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopeStr,
      })}`;
      return authorizeUrl;
    } catch (error) {
      console.error('Error creating authorize URL', error);
      throw new SystemError('Failed to create authorize URL', 500);
    }
  }

  /**
   * @desc Discord 콜백 로직 처리 (Callback)
   * (토큰 교환, 유저 정보 조회, DB 트랜잭션)
   */
  public async handleDiscordCallback(
    code: string,
    userAgent: string | undefined,
    ipAddr: string,
  ): Promise<string> {
    try {
      // 1. Discord API로 토큰 요청
      const tokenResult = await fetchWithTimeout(`${discordApiBaseUrl}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: querystring.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenResult.ok) {
        throw new SystemError('Failed to fetch discord token', 500);
      }
      const tokenData: DiscordTokenAPI = await tokenResult.json();
      const { access_token, token_type } = tokenData;

      // 2. Discord API로 유저 정보 요청
      const userResult = await fetchWithTimeout(`${discordApiBaseUrl}/users/@me`, {
        headers: { Authorization: `${token_type} ${access_token}` },
      });

      if (!userResult.ok) {
        throw new SystemError('Failed to fetch discord user', 500);
      }
      const userData: DiscordUserAPI = await userResult.json();

      // 3. DB 저장을 위한 데이터 포맷팅
      const formattedToken = formatNewToken(tokenData);
      const formattedMember: InsertDiscordMember = {
        id: userData.id,
        displayName: userData.global_name || userData.username,
        avatarUrl: buildAvatarUrl(userData.id, userData.avatar),
      };
      const sessionMaxAge = await systemConfigService.getNumberConfig(
        'COOKIE_MAX_AGE_MS',
        DEFAULT_SESSION_MAX_AGE_MS,
      );
      const newAuthData: InsertAuthSession = {
        discordMemberId: userData.id,
        userAgent,
        ipAddr,
        isActive: true,
        expiresDate: new Date(Date.now() + sessionMaxAge),
      };

      // 4. DB 트랜잭션 호출
      const sessionUid = await this.handleLoginTransaction(
        formattedMember,
        { ...formattedToken, id: userData.id },
        newAuthData,
      );

      // 콜백은 fetchUser를 지나지 않는다. 여기서 갱신하지 않으면 재로그인해도 옛 프로필이
      // TTL만큼 그대로 나간다.
      cacheProfile(userData.id, Promise.resolve(toProfile(userData)));

      return sessionUid;
    } catch (error) {
      console.error('handleDiscordCallback service error', error);
      if (error instanceof SystemError) throw error;
      throw new SystemError('Failed to process Discord callback', 500);
    }
  }

  /**
   * @desc 로그아웃 로직 (Logout)
   * (API 폐기, 세션 비활성화, 토큰 폐기)
   */
  public async revokeAndDeactivateSession(sessionUid: string): Promise<void> {
    try {
      const sessionData = await this.findAuthSessionByUid(sessionUid);
      if (!sessionData) {
        console.warn(`Logout: Session UID ${sessionUid} not found in DB.`);
        return;
      }

      const { discordMemberId } = sessionData;
      // 폐기 단계가 실패해 throw되더라도 캐시는 비어 있어야 하므로 먼저 지운다.
      profileCache.delete(discordMemberId);

      const token = await this.findDiscordTokenById(discordMemberId);

      if (token) {
        await this.revokeDiscordToken(token.accessToken);
        await this.updateDiscordTokenRevoked(discordMemberId);
      } else {
        console.warn(`Logout: Token for member ${discordMemberId} not found in DB.`);
      }

      await this.deactivateSession(sessionUid);
    } catch (error) {
      console.error('revokeAndDeactivateSession service error', error);
      throw new SystemError('Failed to process logout', 500);
    }
  }

  /**
   * @desc Discord API로 사용자 정보 조회 (유저별 캐시)
   */
  public async fetchUser(accessToken: string, discordMemberId: string): Promise<DiscordProfile> {
    const cached = profileCache.get(discordMemberId);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;

    const promise = requestDiscordUser(accessToken);
    cacheProfile(discordMemberId, promise);

    return promise;
  }

  // --- 2. Public Methods (미들웨어에서 호출) ---

  /**
   * @desc 유효한 액세스 토큰을 반환하는 메서드
   */
  public async getValidAccessToken(discordMemberId: string): Promise<string> {
    const token = await this.findDiscordTokenById(discordMemberId);

    if (!token) {
      throw new BusinessError('Token not found or revoked', 401, { isLoggable: false });
    }

    const now = new Date();

    if (now.getTime() > token.reExpiresDate.getTime()) {
      console.warn(`Refresh token expired for member ${discordMemberId}`);
      throw new BusinessError('Session expired. Please log in again.', 401, { isLoggable: false });
    }

    if (now.getTime() < token.acExpiresDate.getTime()) {
      return token.accessToken;
    }

    // ac토큰 만료 시 재발급
    return this.refreshAndSaveToken(discordMemberId, token);
  }

  // --- 3. Internal Business Logic (Private) ---

  /**
   * @desc 로그인/콜백 트랜잭션 처리 (비공개)
   */
  private async handleLoginTransaction(
    newMember: InsertDiscordMember,
    newToken: InsertDiscordToken,
    newAuthData: InsertAuthSession,
  ): Promise<string> {
    try {
      const session = await db.transaction(async (tx) => {
        await this.upsertMember(newMember, tx);
        await this.upsertToken(newToken, tx);
        const sessionResult = await this.insertAuthSession(newAuthData, tx);
        return sessionResult;
      });
      return session.sessionUid;
    } catch (error) {
      console.error('[Login Transaction Error]', error);
      throw new SystemError('Login transaction failed', 500);
    }
  }

  /**
   * @desc Discord 토큰 재발급 및 DB 저장 (비공개)
   */
  private async refreshAndSaveToken(
    discordMemberId: string,
    currentToken: DiscordToken,
  ): Promise<string> {
    try {
      const result = await fetchWithTimeout(`${discordApiBaseUrl}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: querystring.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: currentToken.refreshToken,
        }),
      });

      if (!result.ok) {
        throw new BusinessError('Failed to refresh session. Please log in again.', 401, { isLoggable: false });
      }

      const tokenData: DiscordTokenAPI = await result.json();
      const formattedToken = formatRefreshedToken(tokenData, currentToken.refreshToken);

      await db.update(discordToken).set(formattedToken).where(eq(discordToken.id, discordMemberId));

      return formattedToken.accessToken; // 새 액세스 토큰 반환
    } catch (error) {
      if (error instanceof BusinessError) throw error;
      throw new SystemError('Error during token refresh', 500);
    }
  }

  /**
   * @desc Discord API에 토큰 폐기 요청 (비공개)
   */
  private async revokeDiscordToken(accessToken: string): Promise<void> {
    try {
      const result = await fetchWithTimeout(`${discordApiBaseUrl}/oauth2/token/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: querystring.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          token: accessToken,
        }),
      });

      if (!result.ok) {
        console.warn('Discord revoke API failed', await result.json());
      }
    } catch (fetchError) {
      console.error('Fetch to Discord revoke endpoint failed', fetchError);
    }
  }

  // --- 4. DB Access Layer ---

  /**
   * @desc 디스코드 멤버 저장 (Upsert)
   */
  public async upsertMember(newMember: InsertDiscordMember, tx: TransactionType) {
    try {
      const result = await tx
        .insert(discordMember)
        .values(newMember)
        .onConflictDoUpdate({
          target: discordMember.id,
          set: {
            displayName: newMember.displayName,
            avatarUrl: newMember.avatarUrl,
            updateDate: new Date(),
          },
          where: sql`${discordMember.displayName} IS DISTINCT FROM ${newMember.displayName}
        OR ${discordMember.avatarUrl} IS DISTINCT FROM ${newMember.avatarUrl}`,
        })
        .returning();
      return result;
    } catch (error) {
      console.error('Error upserting discordMember', error);
      throw new SystemError('discordAuth error while upserting discord Member');
    }
  }

  /**
   * @desc 디스코드 토큰 저장 (Upsert)
   */
  public async upsertToken(newToken: InsertDiscordToken, tx: TransactionType) {
    try {
      const result = await tx
        .insert(discordToken)
        .values(newToken)
        .onConflictDoUpdate({
          target: discordToken.id,
          set: {
            accessToken: newToken.accessToken,
            acExpiresDate: newToken.acExpiresDate,
            refreshToken: newToken.refreshToken,
            reExpiresDate: newToken.reExpiresDate,
            scope: newToken.scope,
            tokenType: newToken.tokenType,
            rotatedDate: null,
            revokedDate: null,
          },
        })
        .returning();
      return result[0];
    } catch (error) {
      console.error('Error upserting discordToken');
      throw new SystemError('discordAuth error while upserting discord Token');
    }
  }

  /**
   * @desc ID로 discordToken 조회
   */
  public async findDiscordTokenById(id: string) {
    const result = await db
      .select()
      .from(discordToken)
      .where(and(eq(discordToken.id, id), isNull(discordToken.revokedDate)))
      .limit(1);
    return result[0];
  }

  /**
   * @desc Token revoke update
   */
  public async updateDiscordTokenRevoked(id: string) {
    const result = await db
      .update(discordToken)
      .set({
        revokedDate: new Date(),
      })
      .where(eq(discordToken.id, id))
      .returning();
    return result[0];
  }

  /**
   * @desc AuthSession 저장
   */
  public async insertAuthSession(newAuthData: InsertAuthSession, tx: TransactionType) {
    const result = await tx.insert(authSession).values(newAuthData).returning();

    return result[0];
  }

  /**
   * @desc Uid로 authSession 조회
   */
  public async findAuthSessionByUid(sessionUid: string) {
    const result = await db
      .select()
      .from(authSession)
      .where(
        and(
          eq(authSession.sessionUid, sessionUid),
          eq(authSession.isActive, true),
          // 토큰 갱신 때마다 re_expires_date가 연장돼 리프레시 만료로는 세션이 끊기지 않는다.
          // 만료 상한은 여기서만 걸린다.
          gt(authSession.expiresDate, new Date()),
        ),
      )
      .limit(1);

    return result[0];
  }

  /**
   * @desc session 비활성화
   */
  public async deactivateSession(sessionUid: string) {
    const result = await db
      .update(authSession)
      .set({
        isActive: false,
        updateDate: new Date(),
      })
      .where(eq(authSession.sessionUid, sessionUid))
      .returning();
    return result[0];
  }
}
