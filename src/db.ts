
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

let db: Database<sqlite3.Database, sqlite3.Statement>;

export interface UserProfile {
  id: string;
  points: number;
  level: number;
  experience: number;
  wins: number;
  gamesPlayed: number;
  lastDaily: number;
}

export interface ShopItem {
  id: number;
  name: string;
  description: string;
  price: number;
  emoji: string;
  category: string;
}

export interface InventoryItem {
  id: number;
  userId: string;
  itemId: number;
  quantity: number;
  name: string;
  description: string;
  emoji: string;
}

export async function initDB() {
  db = await open({
    filename: './casino.db',
    driver: sqlite3.Database
  });

  // Создаём таблицу пользователей с новыми полями
  await db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      points INTEGER DEFAULT 1000,
      level INTEGER DEFAULT 1,
      experience INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      games_played INTEGER DEFAULT 0,
      last_daily INTEGER DEFAULT 0
    )
  `);

  // Создаём таблицу предметов магазина
  await db.run(`
    CREATE TABLE IF NOT EXISTS shop_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      price INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general'
    )
  `);

  // Создаём таблицу инвентаря
  await db.run(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      quantity INTEGER DEFAULT 1,
      purchased_at INTEGER DEFAULT 0,
      FOREIGN KEY (item_id) REFERENCES shop_items (id)
    )
  `);

  // Добавляем новые колонки если их нет (для совместимости)
  try {
    await db.run(`ALTER TABLE users ADD COLUMN level INTEGER DEFAULT 1`);
  } catch (e) { /* колонка уже существует */ }
  
  try {
    await db.run(`ALTER TABLE users ADD COLUMN experience INTEGER DEFAULT 0`);
  } catch (e) { /* колонка уже существует */ }
  
  try {
    await db.run(`ALTER TABLE users ADD COLUMN wins INTEGER DEFAULT 0`);
  } catch (e) { /* колонка уже существует */ }
  
  try {
    await db.run(`ALTER TABLE users ADD COLUMN games_played INTEGER DEFAULT 0`);
  } catch (e) { /* колонка уже существует */ }

  // Заполняем магазин базовыми предметами
  await populateShop();
}

async function populateShop() {
  const existingItems = await db.get('SELECT COUNT(*) as count FROM shop_items');
  if (existingItems.count > 0) return; // Магазин уже заполнен

  const items: Omit<ShopItem, 'id'>[] = [
    {
      name: 'Лаки Чарм',
      description: 'Увеличивает шанс выигрыша на 5%',
      price: 5000,
      emoji: '🍀',
      category: 'luck'
    },
    {
      name: 'Золотая Подкова',
      description: 'Приносит удачу в играх',
      price: 10000,
      emoji: '🧿',
      category: 'luck'
    },
    {
      name: 'VIP Статус',
      description: 'Увеличенные ежедневные бонусы',
      price: 25000,
      emoji: '👑',
      category: 'premium'
    },
    {
      name: 'Множитель Опыта',
      description: 'Двойной опыт за игры (24 часа)',
      price: 15000,
      emoji: '⚡',
      category: 'boost'
    },
    {
      name: 'Страховка',
      description: 'Защита от больших проигрышей',
      price: 30000,
      emoji: '🛡️',
      category: 'protection'
    },
    {
      name: 'Магический Кристалл',
      description: 'Увеличивает максимальный выигрыш',
      price: 50000,
      emoji: '💎',
      category: 'premium'
    },
    {
      name: 'Быстрая Перезарядка',
      description: 'Сокращает время ожидания ежедневного бонуса',
      price: 20000,
      emoji: '⏰',
      category: 'utility'
    },
    {
      name: 'Удвоитель Ставок',
      description: 'Возможность делать двойные ставки',
      price: 35000,
      emoji: '🎯',
      category: 'gambling'
    }
  ];

  for (const item of items) {
    await db.run(
      'INSERT INTO shop_items (name, description, price, emoji, category) VALUES (?, ?, ?, ?, ?)',
      [item.name, item.description, item.price, item.emoji, item.category]
    );
  }
}

export async function ensureUserExists(id: string) {
  const user = await db.get<{ id: string }>('SELECT id FROM users WHERE id = ?', id);
  if (!user) {
    await db.run(
      'INSERT INTO users (id, points, level, experience, wins, games_played, last_daily) VALUES (?, ?, ?, ?, ?, ?, ?)', 
      [id, 1000, 1, 0, 0, 0, 0]
    );
  }
}

export async function getPoints(id: string): Promise<number> {
  await ensureUserExists(id);
  await ensureUserExists('casino');
  const row = await db.get<{ points: number }>('SELECT points FROM users WHERE id = ?', id);
  return row?.points ?? 0;
}

export async function addPoints(id: string, amount: number) {
  await ensureUserExists(id);
  await ensureUserExists('casino');
  await db.run('UPDATE users SET points = points + ? WHERE id = ?', amount, id);
}

export async function getUserProfile(id: string): Promise<UserProfile> {
  await ensureUserExists(id);
  await ensureUserExists('casino');
  const row = await db.get<UserProfile>(
    'SELECT id, points, level, experience, wins, games_played, last_daily as lastDaily FROM users WHERE id = ?', 
    id
  );
  
  if (!row) {
    return {
      id,
      points: 1000,
      level: 1,
      experience: 0,
      wins: 0,
      gamesPlayed: 0,
      lastDaily: 0
    };
  }

  // Проверяем повышение уровня
  const newLevel = Math.floor(row.experience / 100) + 1;
  if (newLevel > row.level) {
    await db.run('UPDATE users SET level = ? WHERE id = ?', newLevel, id);
    row.level = newLevel;
  }

  return row;
}

export async function updateUserProfile(id: string, updates: Partial<UserProfile>) {
  await ensureUserExists(id);
  await ensureUserExists('casino');
  
  const fields = [];
  const values = [];
  
  if (updates.experience !== undefined) {
    fields.push('experience = ?');
    values.push(updates.experience);
  }
  
  if (updates.wins !== undefined) {
    fields.push('wins = ?');
    values.push(updates.wins);
  }
  
  if (updates.gamesPlayed !== undefined) {
    fields.push('games_played = ?');
    values.push(updates.gamesPlayed);
  }
  
  if (updates.level !== undefined) {
    fields.push('level = ?');
    values.push(updates.level);
  }

  if (fields.length > 0) {
    values.push(id);
    await db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
  }
}

export async function getLastDaily(id: string): Promise<number> {
  await ensureUserExists(id);
  await ensureUserExists('casino');
  const row = await db.get<{ last_daily: number }>(
    'SELECT last_daily FROM users WHERE id = ?',
    id
  );
  return row?.last_daily ?? 0;
}

export async function setLastDaily(id: string, timestamp: number) {
  await ensureUserExists(id);
  await ensureUserExists('casino');
  await db.run('UPDATE users SET last_daily = ? WHERE id = ?', timestamp, id);
}

export async function getTopUsers(limit: number = 10): Promise<{ id: string, points: number }[]> {
  const rows = await db.all<{ id: string, points: number }[]>(
    'SELECT id, points FROM users ORDER BY points DESC LIMIT ?',
    limit
  );
  return rows;
}

export async function getShopItems(): Promise<ShopItem[]> {
  const rows = await db.all<ShopItem[]>('SELECT * FROM shop_items');
  return rows;
}

export async function buyShopItem(userId: string, itemId: number): Promise<boolean> {
  await ensureUserExists(userId);

  const item = await db.get<ShopItem>('SELECT * FROM shop_items WHERE id = ?', itemId);
  if (!item) return false;

  const userPoints = await getPoints(userId);
  if (userPoints < item.price) return false;

  await addPoints(userId, -item.price);

  const existing = await db.get('SELECT id FROM inventory WHERE user_id = ? AND item_id = ?', userId, itemId);
  if (existing) {
    await db.run('UPDATE inventory SET quantity = quantity + 1 WHERE user_id = ? AND item_id = ?', userId, itemId);
  } else {
    await db.run('INSERT INTO inventory (user_id, item_id, quantity) VALUES (?, ?, ?)', userId, itemId, 1);
  }

  return true;
}

export async function getUserInventory(userId: string): Promise<InventoryItem[]> {
  await ensureUserExists(userId);
  const rows = await db.all<InventoryItem[]>(`
    SELECT 
      i.id, i.user_id as userId, i.item_id as itemId, i.quantity, 
      s.name, s.description, s.emoji 
    FROM inventory i
    JOIN shop_items s ON i.item_id = s.id
    WHERE i.user_id = ?
  `, userId);
  return rows;
}

export async function addToInventory(userId: string, itemId: number, quantity: number = 1) {
  await ensureUserExists(userId);
  const existing = await db.get('SELECT id FROM inventory WHERE user_id = ? AND item_id = ?', userId, itemId);
  if (existing) {
    await db.run('UPDATE inventory SET quantity = quantity + ? WHERE user_id = ? AND item_id = ?', quantity, userId, itemId);
  } else {
    await db.run('INSERT INTO inventory (user_id, item_id, quantity) VALUES (?, ?, ?)', userId, itemId, quantity);
  }
}
