const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(64) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(16) NOT NULL DEFAULT 'viewer',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS holdings (
      asset VARCHAR(16) PRIMARY KEY,
      amount NUMERIC(40, 8) NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS liquidations (
      id SERIAL PRIMARY KEY,
      asset VARCHAR(16) NOT NULL,
      amount NUMERIC(40, 8) NOT NULL,
      usd_value NUMERIC(20, 2) NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function seed() {
  const bcrypt = require('bcryptjs');
  const trumpHash = await bcrypt.hash(process.env.TRUMP_PASSWORD || 'changeme', 10);
  const satoshiHash = await bcrypt.hash(process.env.SATOSHI_PASSWORD || 'changeme', 10);

  await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'viewer')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'viewer'`,
    ['trump26', trumpHash]
  );
  await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'`,
    ['satoshi', satoshiHash]
  );

  await pool.query(
    `INSERT INTO holdings (asset, amount) VALUES ('RAIN', 747500000000)
     ON CONFLICT (asset) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO holdings (asset, amount) VALUES ('ENLV', 200000000)
     ON CONFLICT (asset) DO NOTHING`
  );
}

module.exports = { pool, init, seed };
