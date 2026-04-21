import { google } from 'googleapis'
import type { Transaction } from './db'

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
const SHEET_NAME = 'Sheet1'

const HEADER = [
  'ID', 'Team', 'Date', 'Type',
  'Devices', 'SD Cards', 'Hubs', 'Cables',
  'Ext. Boxes', 'SD Readers', 'Other', 'Other Desc',
  'Notes', 'Created At',
]

function getAuth() {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL
  if (!privateKey || !clientEmail) return null
  return new google.auth.JWT({ email: clientEmail, key: privateKey, scopes: SCOPES })
}

function getSpreadsheetId(): string | null {
  const id = process.env.GOOGLE_SPREADSHEET_ID
  return id && id !== 'YOUR_SHEET_ID_HERE' ? id : null
}

async function ensureHeader(sheets: any, spreadsheetId: string) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A1:N1`,
  })
  if (!res.data.values?.[0]?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] },
    })
  }
}

export async function syncTransactionToSheets(tx: Transaction): Promise<void> {
  const auth = getAuth()
  const spreadsheetId = getSpreadsheetId()
  if (!auth || !spreadsheetId) return

  const sheets = google.sheets({ version: 'v4', auth })
  await ensureHeader(sheets, spreadsheetId)

  const row = [
    tx.id ?? '',
    tx.team_name,
    tx.date,
    tx.type,
    tx.devices,
    tx.sd_cards,
    tx.hubs,
    tx.cables,
    tx.extension_boxes,
    tx.sd_card_readers,
    tx.other,
    tx.other_description ?? '',
    tx.notes ?? '',
    tx.created_at ?? new Date().toISOString(),
  ]

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_NAME}!A:N`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  })
}
