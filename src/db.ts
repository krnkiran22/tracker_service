import { Pool } from 'pg'
import crypto from 'crypto'
import type { Transaction } from './items'

export type { Transaction }
export { ITEMS } from './items'

export type PacketStatus =
  | 'received'
  | 'processing'
  | 'completed'
  | 'received_at_hq'
  | 'counted_and_repacked'
  | 'collected_for_ingestion'
export type UserRole = 'admin' | 'logistics' | 'ingestion' | 'user'

export interface AppUser {
  id: number
  name: string
  email: string
  role: UserRole
  is_verified: boolean
  created_at: string
}

export interface OtpCode {
  id: number
  email: string
  code: string
  expires_at: string
  used: boolean
}

export interface SdPacket {
  id: number
  team_name: string
  factory: string
  date_received: string
  sd_card_count: number
  num_packages: number          // filled at count & repack
  deployment_date?: string | null  // filled at count & repack
  notes?: string | null
  photo_url?: string | null
  photo_urls?: string | null   // JSON array of data-URL strings
  status: PacketStatus
  entered_by: string
  counted_by?: string | null   // person who counted & repacked
  collected_by?: string | null // person who collected for ingestion
  poc_emails: string
  poc_phones?: string | null   // comma-separated WhatsApp numbers e.g. +919876543210
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

export interface SdEvent {
  id: number
  packet_id: number
  event_type: 'received_at_hq' | 'counted_and_repacked' | 'collected_for_ingestion'
  event_data: Record<string, unknown>
  created_at: string
}

export interface TeamWithPoc {
  id: number
  name: string
  poc_name?: string | null
  poc_email?: string | null
  poc_emails?: string | null   // comma-separated default emails for this team
  poc_phones?: string | null   // comma-separated WhatsApp numbers for this team
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
      poc_emails TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS poc_name TEXT;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS poc_email TEXT;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS poc_emails TEXT NOT NULL DEFAULT '';
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS poc_phones TEXT NOT NULL DEFAULT '';

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
      photo_url TEXT,
      photo_urls TEXT,
      status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'completed')),
      entered_by TEXT NOT NULL,
      poc_emails TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE sd_packets ADD COLUMN IF NOT EXISTS photo_url TEXT;
    ALTER TABLE sd_packets ADD COLUMN IF NOT EXISTS photo_urls TEXT;
    ALTER TABLE sd_packets ADD COLUMN IF NOT EXISTS poc_phones TEXT NOT NULL DEFAULT '';
    ALTER TABLE sd_packets ADD COLUMN IF NOT EXISTS num_packages INT NOT NULL DEFAULT 0;
    ALTER TABLE sd_packets ADD COLUMN IF NOT EXISTS deployment_date DATE;
    ALTER TABLE sd_packets ADD COLUMN IF NOT EXISTS counted_by TEXT;
    ALTER TABLE sd_packets ADD COLUMN IF NOT EXISTS collected_by TEXT;

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

    CREATE TABLE IF NOT EXISTS app_users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'logistics', 'ingestion', 'user')),
      is_verified BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS otp_codes (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sd_events (
      id SERIAL PRIMARY KEY,
      packet_id INT NOT NULL REFERENCES sd_packets(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      event_data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `)

  // Expand sd_packets status CHECK to include all event-based statuses
  await db.query(`
    DO $$
    BEGIN
      ALTER TABLE sd_packets DROP CONSTRAINT IF EXISTS sd_packets_status_check;
      ALTER TABLE sd_packets ADD CONSTRAINT sd_packets_status_check
        CHECK (status IN ('received','processing','completed','received_at_hq','counted_and_repacked','collected_for_ingestion'));
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `)
}

// ── Teams ─────────────────────────────────────────────────────────────────────

export async function upsertTeam(name: string, poc_emails?: string, poc_phones?: string) {
  const db = getPool()
  if (poc_emails !== undefined || poc_phones !== undefined) {
    await db.query(
      `INSERT INTO teams (name, poc_emails, poc_phones) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET
         poc_emails = COALESCE(NULLIF($2, ''), teams.poc_emails),
         poc_phones = COALESCE(NULLIF($3, ''), teams.poc_phones)`,
      [name, poc_emails ?? '', poc_phones ?? '']
    )
  } else {
    await db.query(`INSERT INTO teams (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name])
  }
}

export async function getTeams(): Promise<string[]> {
  const db = getPool()
  const res = await db.query(`SELECT name FROM teams ORDER BY name ASC`)
  return res.rows.map((r: { name: string }) => r.name)
}

export async function getTeamsWithEmails(): Promise<{ name: string; poc_emails: string; poc_phones: string }[]> {
  const db = getPool()
  const res = await db.query(`SELECT name, poc_emails, poc_phones FROM teams ORDER BY name ASC`)
  return res.rows
}

export async function getTeamsWithPoc(): Promise<TeamWithPoc[]> {
  const db = getPool()
  const res = await db.query(`SELECT id, name, poc_name, poc_email, poc_emails FROM teams ORDER BY name ASC`)
  return res.rows
}

export async function updateTeamPoc(name: string, poc_name: string, poc_email: string) {
  const db = getPool()
  await db.query(`UPDATE teams SET poc_name=$1, poc_email=$2 WHERE name=$3`, [poc_name, poc_email, name])
}

export async function updateTeam(oldName: string, fields: { name?: string; poc_emails?: string; poc_phones?: string }): Promise<TeamWithPoc | null> {
  const db = getPool()
  const sets: string[] = []
  const values: unknown[] = []
  let idx = 1
  if (fields.name !== undefined)       { sets.push(`name = $${idx++}`);       values.push(fields.name) }
  if (fields.poc_emails !== undefined) { sets.push(`poc_emails = $${idx++}`); values.push(fields.poc_emails) }
  if (fields.poc_phones !== undefined) { sets.push(`poc_phones = $${idx++}`); values.push(fields.poc_phones) }
  if (!sets.length) return null
  values.push(oldName)
  const res = await db.query(
    `UPDATE teams SET ${sets.join(', ')} WHERE name = $${idx} RETURNING *`,
    values
  )
  return res.rows[0] ?? null
}

export async function deleteTeam(name: string): Promise<boolean> {
  const db = getPool()
  const res = await db.query(`DELETE FROM teams WHERE name = $1`, [name])
  return (res.rowCount ?? 0) > 0
}

export async function getUsers(): Promise<AppUser[]> {
  const db = getPool()
  const res = await db.query(`SELECT * FROM app_users ORDER BY created_at DESC`)
  return res.rows
}

export async function deleteUser(id: number): Promise<boolean> {
  const db = getPool()
  const res = await db.query(`DELETE FROM app_users WHERE id = $1`, [id])
  return (res.rowCount ?? 0) > 0
}

export async function updateUserRole(id: number, role: UserRole): Promise<AppUser | null> {
  const db = getPool()
  const res = await db.query(`UPDATE app_users SET role = $1 WHERE id = $2 RETURNING *`, [role, id])
  return res.rows[0] ?? null
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

export async function insertPacket(p: Omit<SdPacket, 'id' | 'created_at'> & { status?: PacketStatus }): Promise<SdPacket> {
  const db = getPool()
  // Save poc_emails + poc_phones back to the team so they auto-fill next time
  await upsertTeam(p.team_name, p.poc_emails || '', (p as any).poc_phones || '')
  const res = await db.query(
    `INSERT INTO sd_packets
       (team_name, factory, date_received, sd_card_count, num_packages, deployment_date,
        notes, photo_url, photo_urls, entered_by, counted_by, collected_by, poc_emails, poc_phones, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [
      p.team_name, p.factory, p.date_received, p.sd_card_count,
      p.num_packages ?? 0,
      p.deployment_date ?? null,
      p.notes ?? null,
      p.photo_url ?? null,
      p.photo_urls ?? null,
      p.entered_by,
      p.counted_by ?? null,
      p.collected_by ?? null,
      p.poc_emails,
      (p as any).poc_phones ?? '',
      p.status ?? 'received',
    ]
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

export async function getPacketsByStatuses(statuses: PacketStatus[]): Promise<SdPacket[]> {
  if (!statuses.length) return []
  const db = getPool()
  const placeholders = statuses.map((_, i) => `$${i + 1}`).join(', ')
  const res = await db.query(
    `SELECT * FROM sd_packets WHERE status IN (${placeholders}) ORDER BY date_received DESC, created_at DESC`,
    statuses
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

export async function updatePacket(id: number, fields: Partial<Omit<SdPacket, 'id' | 'created_at'>>): Promise<SdPacket | null> {
  const db = getPool()
  const allowed = [
    'team_name', 'factory', 'date_received', 'sd_card_count', 'num_packages',
    'deployment_date', 'notes', 'status', 'entered_by', 'counted_by', 'collected_by', 'poc_emails',
  ] as const
  const sets: string[] = []
  const values: unknown[] = []
  let idx = 1
  for (const key of allowed) {
    if ((fields as any)[key] !== undefined) {
      sets.push(`${key} = $${idx++}`)
      values.push((fields as any)[key])
    }
  }
  if (!sets.length) return null
  values.push(id)
  const res = await db.query(
    `UPDATE sd_packets SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  )
  return res.rows[0] ?? null
}

export async function deletePacket(id: number): Promise<boolean> {
  const db = getPool()
  const res = await db.query(`DELETE FROM sd_packets WHERE id = $1`, [id])
  return (res.rowCount ?? 0) > 0
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

export async function updateIngestionRecord(id: number, fields: Partial<Omit<IngestionRecord, 'id' | 'created_at'>>): Promise<IngestionRecord | null> {
  const db = getPool()
  const allowed = ['team_name', 'industry', 'actual_count', 'missing_count', 'extra_count', 'red_cards_count', 'ingested_by', 'deployment_date', 'notes'] as const
  const sets: string[] = []
  const values: unknown[] = []
  let idx = 1
  for (const key of allowed) {
    if ((fields as any)[key] !== undefined) {
      sets.push(`${key} = $${idx++}`)
      values.push((fields as any)[key])
    }
  }
  if (!sets.length) return null
  values.push(id)
  const res = await db.query(
    `UPDATE ingestion_records SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  )
  return res.rows[0] ?? null
}

export async function deleteIngestionRecord(id: number): Promise<boolean> {
  const db = getPool()
  const res = await db.query(`DELETE FROM ingestion_records WHERE id = $1`, [id])
  return (res.rowCount ?? 0) > 0
}

// ── App Users ─────────────────────────────────────────────────────────────────

export async function createUser(name: string, email: string, role: UserRole): Promise<AppUser> {
  const db = getPool()
  const res = await db.query(
    `INSERT INTO app_users (name, email, role) VALUES ($1, $2, $3) RETURNING *`,
    [name, email.toLowerCase().trim(), role]
  )
  return res.rows[0]
}

export async function getUserByEmail(email: string): Promise<AppUser | null> {
  const db = getPool()
  const res = await db.query(`SELECT * FROM app_users WHERE email = $1`, [email.toLowerCase().trim()])
  return res.rows[0] ?? null
}

export async function verifyUser(email: string): Promise<void> {
  const db = getPool()
  await db.query(`UPDATE app_users SET is_verified = true WHERE email = $1`, [email.toLowerCase().trim()])
}

// ── OTP Codes ─────────────────────────────────────────────────────────────────

export function generateOtp(): string {
  return String(crypto.randomInt(100000, 999999))
}

export async function createOtp(email: string): Promise<string> {
  const db = getPool()
  const code = generateOtp()
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

  // Invalidate any existing unused OTPs for this email
  await db.query(`UPDATE otp_codes SET used = true WHERE email = $1 AND used = false`, [email.toLowerCase().trim()])

  await db.query(
    `INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, $3)`,
    [email.toLowerCase().trim(), code, expiresAt]
  )
  return code
}

// ── SD Events ─────────────────────────────────────────────────────────────────

export async function insertSdEvent(
  packet_id: number,
  event_type: SdEvent['event_type'],
  event_data: Record<string, unknown>
): Promise<SdEvent> {
  const db = getPool()
  const res = await db.query(
    `INSERT INTO sd_events (packet_id, event_type, event_data)
     VALUES ($1, $2, $3) RETURNING *`,
    [packet_id, event_type, JSON.stringify(event_data)]
  )
  return res.rows[0]
}

export async function getSdEventsByPacketId(packet_id: number): Promise<SdEvent[]> {
  const db = getPool()
  const res = await db.query(
    `SELECT * FROM sd_events WHERE packet_id = $1 ORDER BY created_at ASC`,
    [packet_id]
  )
  return res.rows
}

// ── OTP ───────────────────────────────────────────────────────────────────────

export async function verifyOtp(email: string, code: string): Promise<boolean> {
  const db = getPool()
  const res = await db.query(
    `SELECT * FROM otp_codes
     WHERE email = $1 AND code = $2 AND used = false AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [email.toLowerCase().trim(), code.trim()]
  )
  if (!res.rows[0]) return false

  // Mark as used
  await db.query(`UPDATE otp_codes SET used = true WHERE id = $1`, [res.rows[0].id])
  return true
}
