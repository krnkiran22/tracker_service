import { Router, Request, Response } from 'express'
import { insertTransaction, getTransactions, updateTransaction, deleteTransaction } from '../db'
import { syncTransactionToSheets } from '../sheets'

const router = Router()

// GET /api/transactions
router.get('/', async (req: Request, res: Response) => {
  try {
    const { team, type, from, to } = req.query as Record<string, string>
    const rows = await getTransactions({
      team:  team  || undefined,
      type:  type  || undefined,
      from:  from  || undefined,
      to:    to    || undefined,
    })
    res.json(rows)
  } catch (err) {
    console.error('GET /api/transactions error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/transactions
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      team_name, type, date, devices, sd_cards, hubs, cables,
      extension_boxes, sd_card_readers, other, other_description,
      photo_url, notes, entered_by,
    } = req.body

    if (!team_name || !type || !date) {
      res.status(400).json({ error: 'team_name, type, date are required' })
      return
    }

    const tx = await insertTransaction({
      team_name: String(team_name).trim(),
      type,
      date,
      devices:         Number(devices)         || 0,
      sd_cards:        Number(sd_cards)        || 0,
      hubs:            Number(hubs)            || 0,
      cables:          Number(cables)          || 0,
      extension_boxes: Number(extension_boxes) || 0,
      sd_card_readers: Number(sd_card_readers) || 0,
      other:           Number(other)           || 0,
      other_description: other_description || null,
      photo_url:  photo_url  || null,
      notes:      notes      || null,
      entered_by: entered_by || null,
    })

    syncTransactionToSheets(tx).catch(e =>
      console.warn('Sheets sync failed (non-fatal):', e)
    )

    res.json(tx)
  } catch (err) {
    console.error('POST /api/transactions error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// PUT /api/transactions/:id  (also used by Google Apps Script sync)
router.put('/:id', async (req: Request, res: Response) => {
  const secret   = process.env.SHEETS_SYNC_SECRET
  const provided = req.headers['x-sync-secret'] as string | undefined
  if (provided !== undefined && secret && provided !== secret) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const id = Number(req.params.id)
  if (!id || isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }

  try {
    const body = req.body
    const tx = {
      team_name:         body.team_name         ?? body.Team         ?? undefined,
      type:              body.type              ?? body.Type         ?? undefined,
      date:              body.date              ?? body.Date         ?? undefined,
      devices:           body.devices           != null ? Number(body.devices)           : body.Devices           != null ? Number(body.Devices)           : undefined,
      sd_cards:          body.sd_cards          != null ? Number(body.sd_cards)          : body['SD Cards']       != null ? Number(body['SD Cards'])       : undefined,
      hubs:              body.hubs              != null ? Number(body.hubs)              : body.Hubs              != null ? Number(body.Hubs)              : undefined,
      cables:            body.cables            != null ? Number(body.cables)            : body.Cables            != null ? Number(body.Cables)            : undefined,
      extension_boxes:   body.extension_boxes   != null ? Number(body.extension_boxes)   : body['Ext. Boxes']     != null ? Number(body['Ext. Boxes'])     : undefined,
      sd_card_readers:   body.sd_card_readers   != null ? Number(body.sd_card_readers)   : body['SD Readers']     != null ? Number(body['SD Readers'])     : undefined,
      other:             body.other             != null ? Number(body.other)             : body.Other             != null ? Number(body.Other)             : undefined,
      other_description: body.other_description ?? body['Other Desc'] ?? undefined,
      notes:             body.notes             ?? body.Notes         ?? undefined,
    }

    const updated = await updateTransaction(id, tx)
    if (!updated) {
      res.status(404).json({ error: 'Transaction not found or nothing to update' })
      return
    }
    res.json(updated)
  } catch (err) {
    console.error(`PUT /api/transactions/${id} error:`, err)
    res.status(500).json({ error: String(err) })
  }
})

// DELETE /api/transactions/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (!id || isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return }
  try {
    const deleted = await deleteTransaction(id)
    if (!deleted) { res.status(404).json({ error: 'Not found' }); return }
    res.json({ success: true })
  } catch (err) {
    console.error(`DELETE /api/transactions/${id} error:`, err)
    res.status(500).json({ error: String(err) })
  }
})

export default router
