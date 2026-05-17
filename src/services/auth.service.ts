import { randomBytes } from 'node:crypto';
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

export const authService = {
  async register(email: string, password: string, name: string): Promise<AuthUser> {
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });
    const [user] = await userRepo.create({ email, passwordHash, name });
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  },

  async login(email: string, password: string): Promise<{ user: AuthUser; token: string } | null> {
    const user = await userRepo.findByEmail(email);
    if (!user) return null;

    const ok = await Bun.password.verify(password, user.passwordHash);
    if (!ok) return null;

    const token = randomBytes(SESSION_TOKEN_LEN).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_COOKIE_MAX_AGE * 1000);

    await sessionRepo.create({ userId: user.id, tokenHash: token, expiresAt });

    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      token,
    };
  },

  async validateSession(token: string): Promise<AuthUser | null> {
    const session = await sessionRepo.findByToken(token);
    if (!session) return null;

    const user = await userRepo.findById(session.userId);
    if (!user) return null;

    return { id: user.id, email: user.email, name: user.name, role: user.role };
  },

  async logout(userId: number) {
    await sessionRepo.deleteByUserId(userId);
  },

  async needsSetup(): Promise<boolean> {
    const count = await userRepo.count();
    return count === 0;
  },
};
