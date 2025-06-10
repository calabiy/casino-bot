import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

let db: Database<sqlite3.Database, sqlite3.Statement>;

export async function initDB() {
  db = await open({
    filename: './casino.db',
    driver: sqlite3.Database
  });

  await db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      points INTEGER DEFAULT 1000,
      last_daily INTEGER
    )
  `);
}

export async function ensureUserExists(id: string) {
  const user = await db.get<{ id: string }>('SELECT id FROM users WHERE id = ?', id);
  if (!user) {
    await db.run('INSERT INTO users (id, points, last_daily) VALUES (?, ?, ?)', id, 1000, 0);
  }
}

export async function getPoints(id: string): Promise<number> {
  await ensureUserExists(id);
  const row = await db.get<{ points: number }>('SELECT points FROM users WHERE id = ?', id);
  return row?.points ?? 0;
}

export async function addPoints(id: string, amount: number) {
  await ensureUserExists(id);
  await db.run('UPDATE users SET points = points + ? WHERE id = ?', amount, id);
}

export async function getLastDaily(id: string): Promise<number> {
  await ensureUserExists(id);
  const row = await db.get<{ last_daily: number }>('SELECT last_daily FROM users WHERE id = ?', id);
  return row?.last_daily ?? 0;
}

export async function setLastDaily(id: string, time: number) {
  await ensureUserExists(id);
  await db.run('UPDATE users SET last_daily = ? WHERE id = ?', time, id);
}

export async function getTopUsers(limit: number): Promise<{ id: string, points: number }[]> {
  const rows = await db.all<{ id: string, points: number }[]>(
    'SELECT id, points FROM users ORDER BY points DESC LIMIT ?',
    limit
  );
  return rows;
}
