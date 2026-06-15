import bcrypt from 'bcrypt';
import { env } from './env';

export function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, env.BCRYPT_COST);
}

export function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}
