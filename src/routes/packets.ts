import { Router, Request, Response } from 'express'
import {
  insertPacket, getPackets, getPacketById,
  updatePacketStatus, updatePacket, deletePacket,
  insertIngestionRecord, getIngestionRecordByPacketId,
  insertSdEvent, getSdEventsByPacketId,
} from '../db'
import type { PacketStatus } from '../db'
import {
  sendPacketReceivedEmail,
  sendPacketAcknowledgedEmail,
  sendIngestionCompleteEmail,
} from '../email'
import {
  waSendPacketReceived,
  waSendPacketAcknowledged,
  waSendIngestionComplete,
  waSendReceivedAtHQ,
  waSendCountedAndRepacked,
} from '../whatsapp'

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
// Supports two flows:
//   New event-based flow:  { team_name, received_date, poc_phones, entered_by }
//   Legacy admin flow:     { team_name, factory, date_received, sd_card_count, ... }
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body

    // ── New event-based logistics flow (received_at_hq) ──────────────────────
    if (!body.factory && body.received_date) {
      const { team_name, received_date, poc_phones, entered_by } = body
      if (!team_name || !received_date) {
        res.status(400).json({ error: 'team_name and received_date are required' })
        return
      }

      const packet = await insertPacket({
        team_name,
        factory:        '',
        date_received:  received_date,
        sd_card_count:  0,
        notes:          null,
        photo_url:      null,
        photo_urls:     null,
        entered_by:     entered_by || 'Logistics',
        poc_emails:     '',
        poc_phones:     poc_phones || '',
        status:         'received_at_hq',
      } as any)

      // Log the event
      await insertSdEvent(packet.id, 'received_at_hq', {
        team_name,
        received_date,
        poc_phones: poc_phones || '',
        entered_by: entered_by || 'Logistics',
      })

      waSendReceivedAtHQ(packet as any).catch(err =>
        console.error('waSendReceivedAtHQ failed:', err)
      )

      res.status(201).json(packet)
      return
    }

    // ── Legacy flow (admin / full form) ──────────────────────────────────────
    const { team_name, factory, date_received, sd_card_count, notes, photo_url, photo_urls, entered_by, poc_emails, poc_phones } = body

    if (!team_name || !factory || !date_received || !entered_by) {
      res.status(400).json({ error: 'Missing required fields' })
      return
    }

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
      poc_phones:    poc_phones || '',
    } as any)

    sendPacketReceivedEmail(packet).catch(err =>
      console.error('sendPacketReceivedEmail failed:', err)
    )
    waSendPacketReceived(packet as any).catch(err =>
      console.error('waSendPacketReceived failed:', err)
    )

    res.status(201).json(packet)
  } catch (err) {
    console.error('POST /api/packets error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/packets/:id/events — log a new event against an existing packet
router.post('/:id/events', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const { event_type, event_data } = req.body as {
      event_type: 'counted_and_repacked'
      event_data: Record<string, unknown>
    }

    if (!event_type || !event_data) {
      res.status(400).json({ error: 'event_type and event_data are required' })
      return
    }

    const packet = await getPacketById(id)
    if (!packet) { res.status(404).json({ error: 'Packet not found' }); return }

    // Log the event
    const event = await insertSdEvent(id, event_type, event_data)

    // Update packet status + sd_card_count if provided
    const updatedPacket = await updatePacket(id, {
      status: event_type as PacketStatus,
      ...(event_data.sd_card_count !== undefined
        ? { sd_card_count: Number(event_data.sd_card_count) }
        : {}),
    })

    if (event_type === 'counted_and_repacked') {
      waSendCountedAndRepacked(updatedPacket as any, event_data).catch(err =>
        console.error('waSendCountedAndRepacked failed:', err)
      )
    }

    res.status(201).json({ packet: updatedPacket, event })
  } catch (err) {
    console.error(`POST /api/packets/${req.params.id}/events error:`, err)
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/packets/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const packet = await getPacketById(id)
    if (!packet) { res.status(404).json({ error: 'Not found' }); return }
    const [ingestion, events] = await Promise.all([
      getIngestionRecordByPacketId(id),
      getSdEventsByPacketId(id),
    ])
    res.json({ packet, ingestion, events })
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
      waSendPacketAcknowledged(updated! as any).catch(err =>
        console.error('waSendPacketAcknowledged failed:', err)
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
      waSendIngestionComplete(updatedPacket! as any, record).catch(err =>
        console.error('waSendIngestionComplete failed:', err)
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
