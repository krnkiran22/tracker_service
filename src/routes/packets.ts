import { Router, Request, Response } from 'express'
import {
  insertPacket, getPackets, getPacketById,
  updatePacketStatus, updatePacket, deletePacket,
  insertIngestionRecord, getIngestionRecordByPacketId,
} from '../db'
import type { PacketStatus } from '../db'
import {
  sendPacketReceivedEmail,
  sendPacketAcknowledgedEmail,
  sendIngestionCompleteEmail,
} from '../email'

const router = Router()

// GET /api/packets
router.get('/', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as PacketStatus | undefined
    const packets = await getPackets(status ? { status } : undefined)
    res.json(packets)
  } catch (err) {
    console.error('GET /api/packets error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/packets
router.post('/', async (req: Request, res: Response) => {
  try {
    const { team_name, factory, date_received, sd_card_count, notes, photo_url, photo_urls, entered_by, poc_emails } = req.body

    if (!team_name || !factory || !date_received || !entered_by) {
      res.status(400).json({ error: 'Missing required fields' })
      return
    }

    // photo_urls is a JSON-stringified string[] from the frontend
    const packet = await insertPacket({
      team_name,
      factory,
      date_received,
      sd_card_count: Number(sd_card_count) || 0,
      notes:         notes || null,
      photo_url:     photo_url || null,
      photo_urls:    photo_urls || null,
      entered_by,
      poc_emails:    poc_emails || '',
    })

    sendPacketReceivedEmail(packet).catch(err =>
      console.error('sendPacketReceivedEmail failed:', err)
    )

    res.status(201).json(packet)
  } catch (err) {
    console.error('POST /api/packets error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/packets/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const packet = await getPacketById(id)
    if (!packet) { res.status(404).json({ error: 'Not found' }); return }
    const ingestion = await getIngestionRecordByPacketId(id)
    res.json({ packet, ingestion })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// PATCH /api/packets/:id  — acknowledge | complete
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const { action, ...ingestionData } = req.body

    const packet = await getPacketById(id)
    if (!packet) { res.status(404).json({ error: 'Not found' }); return }

    if (action === 'acknowledge') {
      if (packet.status !== 'received') {
        res.status(400).json({ error: 'Packet is not in received state' })
        return
      }
      const updated = await updatePacketStatus(id, 'processing')
      sendPacketAcknowledgedEmail(updated!).catch(err =>
        console.error('sendPacketAcknowledgedEmail failed:', err)
      )
      res.json(updated)
      return
    }

    if (action === 'complete') {
      if (packet.status !== 'processing') {
        res.status(400).json({ error: 'Packet is not in processing state' })
        return
      }

      const {
        team_name, industry, actual_count, missing_count, extra_count,
        red_cards_count, ingested_by, deployment_date, notes,
      } = ingestionData

      if (!team_name || !industry || !ingested_by || !deployment_date) {
        res.status(400).json({ error: 'Missing ingestion fields' })
        return
      }

      const record = await insertIngestionRecord({
        packet_id:       id,
        team_name,
        industry,
        actual_count:    Number(actual_count)    || 0,
        missing_count:   Number(missing_count)   || 0,
        extra_count:     Number(extra_count)     || 0,
        red_cards_count: Number(red_cards_count) || 0,
        ingested_by,
        deployment_date,
        notes: notes || null,
      })

      const updatedPacket = await updatePacketStatus(id, 'completed')

      sendIngestionCompleteEmail(updatedPacket!, record).catch(err =>
        console.error('sendIngestionCompleteEmail failed:', err)
      )

      res.json({ packet: updatedPacket, ingestion: record })
      return
    }

    res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    console.error(`PATCH /api/packets/${req.params.id} error:`, err)
    res.status(500).json({ error: String(err) })
  }
})

// PUT /api/packets/:id — admin full edit
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const updated = await updatePacket(id, req.body)
    if (!updated) { res.status(404).json({ error: 'Not found' }); return }
    res.json(updated)
  } catch (err) {
    console.error(`PUT /api/packets/${req.params.id} error:`, err)
    res.status(500).json({ error: String(err) })
  }
})

// DELETE /api/packets/:id — admin delete
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const ok = await deletePacket(id)
    if (!ok) { res.status(404).json({ error: 'Not found' }); return }
    res.json({ success: true })
  } catch (err) {
    console.error(`DELETE /api/packets/${req.params.id} error:`, err)
    res.status(500).json({ error: String(err) })
  }
})

export default router
