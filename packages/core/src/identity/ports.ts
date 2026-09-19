/** Password hashing, implemented by @knoverge/auth. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, passwordHash: string): Promise<boolean>;
  /** Hash used to equalise timing when the user does not exist. */
  dummyHash(): Promise<string>;
}

/** Opaque session tokens, implemented by @knoverge/auth. */
export interface TokenService {
  generate(): string;
  hash(token: string): string;
}
