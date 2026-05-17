import { createHash, randomBytes } from 'node:crypto';
import { userRepo } from '../db/repositories/user.repo.ts';
import { sessionRepo } from '../db/repositories/session.repo.ts';

const SESSION_TOKEN_LEN = 48;
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

export const SESSION_COOKIE = 'oo_session';

export type AuthUser = {
  id: number;
  email: string;
  name: string;
  role: string;
};

// The cookie carries the raw token; only its sha256 is persisted, so a DB
// leak can't be replayed as a live session. sha256 (not argon2) is correct
// here — the token is 48 bytes of CSPRNG entropy, not a low-entropy secret.
function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const authService = {
  async register(email: string, password: string, name: string): Promise<AuthUser> {
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });
    const [user] = await userRepo.create({ email, passwordHash, name });
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  },

  // Mints a fresh session and returns the raw token for the cookie. Only
  // the hash is stored.
  async createSession(user: AuthUser): Promise<string> {
    const token = randomBytes(SESSION_TOKEN_LEN).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_COOKIE_MAX_AGE * 1000);
    await sessionRepo.create({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
    });
    return token;
  },

  async login(email: string, password: string): Promise<{ user: AuthUser; token: string } | null> {
    const user = await userRepo.findByEmail(email);
    if (!user) return null;

    const ok = await Bun.password.verify(password, user.passwordHash);
    if (!ok) return null;

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
    const token = await this.createSession(authUser);

    return { user: authUser, token };
  },

  async validateSession(token: string): Promise<AuthUser | null> {
    const session = await sessionRepo.findByToken(hashSessionToken(token));
    if (!session) return null;

    const user = await userRepo.findById(session.userId);
    if (!user) return null;

    return { id: user.id, email: user.email, name: user.name, role: user.role };
  },

  async logoutSession(token: string) {
    await sessionRepo.deleteByToken(hashSessionToken(token));
  },

  async needsSetup(): Promise<boolean> {
    const count = await userRepo.count();
    return count === 0;
  },
};
