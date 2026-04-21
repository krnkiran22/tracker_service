import { Pool } from 'pg'
import type { Transaction } from './items'

export type { Transaction }
export { ITEMS } from './items'

export type PacketStatus = 'received' | 'processing' | 'completed'

export interface SdPacket {
  id: number
  team_name: string
  factory: string
  date_received: string
  sd_card_count: number
  notes?: string | null
  status: PacketStatus
  entered_by: string
  poc_emails: string
  created_at: string
}

export interface IngestionRecord {
  id: number
  packet_id: number
  team_name: string
  industry: string
  actual_count: number
  missing_count: number
  extra_count: number
  red_cards_count: number
  ingested_by: string
  deployment_date: string
  notes?: string | null
  created_at: string
}

export interface TeamWithPoc {
  id: number
  name: string
  poc_name?: string | null
  poc_email?: string | null
}

// ── Pool ──────────────────────────────────────────────────────────────────────

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL is not set')
    try { new URL(connectionString) } catch {
      throw new Error(
        'DATABASE_URL is not a valid URL. Percent-encode any special characters. ' +
        'Get the pre-encoded URL from Railway → Postgres → Connect tab → Database URL.'
      )
    }
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })
  }
  return pool
}

// ── Schema migration ──────────────────────────────────────────────────────────

export async function initDB() {
  const db = getPool()
  await db.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      poc_name TEXT,
      poc_email TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS poc_name TEXT;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS poc_email TEXT;

    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      team_name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('sent', 'received')),
      date DATE NOT NULL,
      devices INT NOT NULL DEFAULT 0,
      sd_cards INT NOT NULL DEFAULT 0,
      hubs INT NOT NULL DEFAULT 0,
      cables INT NOT NULL DEFAULT 0,
      extension_boxes INT NOT NULL DEFAULT 0,
      sd_card_readers INT NOT NULL DEFAULT 0,
      other INT NOT NULL DEFAULT 0,
      other_description TEXT,
      photo_url TEXT,
      notes TEXT,
      entered_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS entered_by TEXT;

    CREATE TABLE IF NOT EXISTS sd_packets (
      id SERIAL PRIMARY KEY,
      team_name TEXT NOT NULL,
      factory TEXT NOT NULL,
      date_received DATE NOT NULL,
      sd_card_count INT NOT NULL DEFAULT 0,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'completed')),
      entered_by TEXT NOT NULL,
      poc_emails TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ingestion_records (
      id SERIAL PRIMARY KEY,
      packet_id INT NOT NULL REFERENCES sd_packets(id) ON DELETE CASCADE,
      team_name TEXT NOT NULL,
      industry TEXT NOT NULL,
      actual_count INT NOT NULL DEFAULT 0,
      missing_count INT NOT NULL DEFAULT 0,
      extra_count INT NOT NULL DEFAULT 0,
      red_cards_count INT NOT NULL DEFAULT 0,
      ingested_by TEXT NOT NULL,
      deployment_date DATE NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `)
}

// ── Teams ─────────────────────────────────────────────────────────────────────

export async function upsertTeam(name: string) {
  const db = getPool()
  await db.query(`INSERT INTO teams (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name])
}

export async function getTeams(): Promise<string[]> {
  const db = getPool()
  const res = await db.query(`SELECT name FROM teams ORDER BY name ASC`)
  return res.rows.map((r: { name: string }) => r.name)
}

export async function getTeamsWithPoc(): Promise<TeamWithPoc[]> {
  const db = getPool()
  const res = await db.query(`SELECT id, name, poc_name, poc_email FROM teams ORDER BY name ASC`)
  return res.rows
}

export async function updateTeamPoc(name: string, poc_name: string, poc_email: string) {
  const db = getPool()
  await db.query(`UPDATE teams SET poc_name=$1, poc_email=$2 WHERE name=$3`, [poc_name, poc_email, name])
}

// ── Transactions ──────────────────────────────────────────────────────────────

export async function insertTransaction(tx: Transaction): Promise<Transaction> {
  const db = getPool()
  await upsertTeam(tx.team_name)
  const res = await db.query(
    `INSERT INTO transactions
      (team_name, type, date, devices, sd_cards, hubs, cables, extension_boxes,
       sd_card_readers, other, other_description, photo_url, notes, entered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
      tx.team_name, tx.type, tx.date,
      tx.devices, tx.sd_cards, tx.hubs, tx.cables,
      tx.extension_boxes, tx.sd_card_readers,
      tx.other, tx.other_description ?? null,
      tx.photo_url ?? null, tx.notes ?? null, tx.entered_by ?? null,
    ]
  )
  return res.rows[0]
}

export async function updateTransaction(id: number, tx: Partial<Transaction>): Promise<Transaction | null> {
  const db = getPool()
  const fields: string[] = []
  const values: unknown[] = []
  let idx = 1

  const allowed = [
    'team_name', 'type', 'date', 'devices', 'sd_cards', 'hubs', 'cables',
    'extension_boxes', 'sd_card_readers', 'other', 'other_description', 'notes', 'entered_by',
  ] as const

  for (const key of allowed) {
    if ((tx as any)[key] !== undefined) {
      fields.push(`${key} = $${idx++}`)
      values.push((tx as any)[key])
    }
  }
  if (fields.length === 0) return null

  values.push(id)
  const res = await db.query(
    `UPDATE transactions SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  )
  return res.rows[0] ?? null
}

export async function deleteTransaction(id: number): Promise<boolean> {
  const db = getPool()
  const res = await db.query(`DELETE FROM transactions WHERE id = $1`, [id])
  return (res.rowCount ?? 0) > 0
}

export async function getTransactions(filters?: {
  team?: string; type?: string; from?: string; to?: string
}): Promise<Transaction[]> {
  const db = getPool()
  const conditions: string[] = []
  const values: unknown[] = []
  let idx = 1

  if (filters?.team) { conditions.push(`team_name = $${idx++}`); values.push(filters.team) }
  if (filters?.type && filters.type !== 'all') { conditions.push(`type = $${idx++}`); values.push(filters.type) }
  if (filters?.from) { conditions.push(`date >= $${idx++}`); values.push(filters.from) }
  if (filters?.to)   { conditions.push(`date <= $${idx++}`); values.push(filters.to) }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const res = await db.query(
    `SELECT * FROM transactions ${where} ORDER BY date DESC, created_at DESC`,
    values
  )
  return res.rows
}

// ── SD Packets ────────────────────────────────────────────────────────────────

export async function insertPacket(p: Omit<SdPacket, 'id' | 'created_at' | 'status'>): Promise<SdPacket> {
  const db = getPool()
  await upsertTeam(p.team_name)
  const res = await db.query(
    `INSERT INTO sd_packets (team_name, factory, date_received, sd_card_count, notes, entered_by, poc_emails)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [p.team_name, p.factory, p.date_received, p.sd_card_count, p.notes ?? null, p.entered_by, p.poc_emails]
  )
  return res.rows[0]
}

export async function getPackets(filters?: { status?: PacketStatus }): Promise<SdPacket[]> {
  const db = getPool()
  const conditions: string[] = []
  const values: unknown[] = []
  if (filters?.status) { conditions.push(`status = $1`); values.push(filters.status) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const res = await db.query(
    `SELECT * FROM sd_packets ${where} ORDER BY date_received DESC, created_at DESC`,
    values
  )
  return res.rows
}

export async function getPacketById(id: number): Promise<SdPacket | null> {
  const db = getPool()
  const res = await db.query(`SELECT * FROM sd_packets WHERE id = $1`, [id])
  return res.rows[0] ?? null
}

export async function updatePacketStatus(id: number, status: PacketStatus): Promise<SdPacket | null> {
  const db = getPool()
  const res = await db.query(
    `UPDATE sd_packets SET status = $1 WHERE id = $2 RETURNING *`,
    [status, id]
  )
  return res.rows[0] ?? null
}

// ── Ingestion Records ─────────────────────────────────────────────────────────

export async function insertIngestionRecord(r: Omit<IngestionRecord, 'id' | 'created_at'>): Promise<IngestionRecord> {
  const db = getPool()
  const res = await db.query(
    `INSERT INTO ingestion_records
      (packet_id, team_name, industry, actual_count, missing_count, extra_count, red_cards_count, ingested_by, deployment_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      r.packet_id, r.team_name, r.industry,
      r.actual_count, r.missing_count, r.extra_count, r.red_cards_count,
      r.ingested_by, r.deployment_date, r.notes ?? null,
    ]
  )
  return res.rows[0]
}

export async function getIngestionRecords(): Promise<IngestionRecord[]> {
  const db = getPool()
  const res = await db.query(`SELECT * FROM ingestion_records ORDER BY created_at DESC`)
  return res.rows
}

export async function getIngestionRecordByPacketId(packetId: number): Promise<IngestionRecord | null> {
  const db = getPool()
  const res = await db.query(`SELECT * FROM ingestion_records WHERE packet_id = $1`, [packetId])
  return res.rows[0] ?? null
}
