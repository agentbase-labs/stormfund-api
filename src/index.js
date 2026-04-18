const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DateTime } = require('luxon');
const { pool, init, seed } = require('./db');
const { getPrices } = require('./prices');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TZ = 'Asia/Jerusalem';

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'admin only' });
  }
  next();
}

app.get('/health', (req, res) => res.json({ ok: true, app: 'stormfund', v: '1.1', ts: Date.now(), tz: TZ }));

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const r = await pool.query('SELECT id, username, password_hash, role FROM users WHERE username = $1', [username]);
    const u = r.rows[0];
    if (!u) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    const token = jwt.sign({ sub: u.id, username: u.username, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { username: u.username, role: u.role } });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

app.get('/prices', async (req, res) => {
  try {
    const p = await getPrices();
    res.json(p);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/holdings', authMiddleware, async (req, res) => {
  const r = await pool.query('SELECT asset, amount, updated_at FROM holdings ORDER BY asset');
  res.json(r.rows.map(h => ({ asset: h.asset, amount: Number(h.amount), updated_at: h.updated_at })));
});

app.put('/holdings', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { asset, amount } = req.body || {};
    if (!asset || amount == null) return res.status(400).json({ error: 'asset and amount required' });
    const a = String(asset).toUpperCase();
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: 'invalid amount' });
    const r = await pool.query(
      `INSERT INTO holdings (asset, amount, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (asset) DO UPDATE SET amount = EXCLUDED.amount, updated_at = NOW()
       RETURNING asset, amount, updated_at`,
      [a, amt]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('put holdings', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/liquidations', authMiddleware, async (req, res) => {
  const r = await pool.query('SELECT id, asset, amount, usd_value, note, created_at FROM liquidations ORDER BY created_at DESC');
  res.json(r.rows.map(l => ({
    id: l.id,
    asset: l.asset,
    amount: Number(l.amount),
    usd_value: Number(l.usd_value),
    note: l.note,
    created_at: l.created_at,
  })));
});

app.get('/liquidations/summary', authMiddleware, async (req, res) => {
  try {
    // "Today" = current calendar day in Israel time (Asia/Jerusalem)
    const startIsrael = DateTime.now().setZone(TZ).startOf('day');
    const endIsrael = startIsrael.plus({ days: 1 });
    const startUtc = startIsrael.toUTC().toISO();
    const endUtc = endIsrael.toUTC().toISO();

    const today = await pool.query(
      `SELECT COALESCE(SUM(usd_value), 0) AS total
         FROM liquidations
        WHERE created_at >= $1 AND created_at < $2`,
      [startUtc, endUtc]
    );
    const all = await pool.query(`SELECT COALESCE(SUM(usd_value), 0) AS total FROM liquidations`);
    res.json({
      daily_usd: Number(today.rows[0].total),
      all_time_usd: Number(all.rows[0].total),
      tz: TZ,
      day_start_utc: startUtc,
      day_end_utc: endUtc,
    });
  } catch (e) {
    console.error('liquidations summary', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/liquidations', authMiddleware, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const { asset, amount, usd_value, note, created_at } = req.body || {};
    if (!asset || amount == null || usd_value == null) {
      return res.status(400).json({ error: 'asset, amount, usd_value required' });
    }
    const a = String(asset).toUpperCase();
    const amt = Number(amount);
    const usd = Number(usd_value);
    if (!Number.isFinite(amt) || !Number.isFinite(usd)) return res.status(400).json({ error: 'invalid numbers' });
    if (amt <= 0) return res.status(400).json({ error: 'amount must be positive' });
    const ts = created_at ? new Date(created_at) : new Date();

    await client.query('BEGIN');

    const ins = await client.query(
      `INSERT INTO liquidations (asset, amount, usd_value, note, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, asset, amount, usd_value, note, created_at`,
      [a, amt, usd, note || null, ts]
    );

    // Reduce holdings atomically. Insert row if missing, then subtract.
    await client.query(
      `INSERT INTO holdings (asset, amount, updated_at) VALUES ($1, 0, NOW())
       ON CONFLICT (asset) DO NOTHING`,
      [a]
    );
    const upd = await client.query(
      `UPDATE holdings SET amount = amount - $1, updated_at = NOW()
        WHERE asset = $2
        RETURNING asset, amount`,
      [amt, a]
    );

    await client.query('COMMIT');
    const row = ins.rows[0];
    res.json({
      id: row.id,
      asset: row.asset,
      amount: Number(row.amount),
      usd_value: Number(row.usd_value),
      note: row.note,
      created_at: row.created_at,
      holdings_after: upd.rows[0] ? { asset: upd.rows[0].asset, amount: Number(upd.rows[0].amount) } : null,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('post liquidations', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.delete('/liquidations/:id', authMiddleware, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

    await client.query('BEGIN');
    const fetched = await client.query(
      `SELECT id, asset, amount FROM liquidations WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (fetched.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    const liq = fetched.rows[0];
    await client.query('DELETE FROM liquidations WHERE id = $1', [id]);
    const upd = await client.query(
      `UPDATE holdings SET amount = amount + $1, updated_at = NOW()
        WHERE asset = $2
        RETURNING asset, amount`,
      [Number(liq.amount), liq.asset]
    );
    await client.query('COMMIT');
    res.json({
      ok: true,
      restored: { asset: liq.asset, amount: Number(liq.amount) },
      holdings_after: upd.rows[0] ? { asset: upd.rows[0].asset, amount: Number(upd.rows[0].amount) } : null,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('delete liquidations', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await init();
    await seed();
    console.log('[stormfund] DB ready');
  } catch (e) {
    console.error('[stormfund] DB init error:', e.message);
  }
  app.listen(PORT, () => console.log(`[stormfund] API listening on ${PORT} (tz=${TZ})`));
})();