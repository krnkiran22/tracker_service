import { Router, Request, Response } from 'express'
import {
  insertPacket, getPackets, getPacketsByStatuses, getPacketsByAssignee, getPacketById,
  updatePacketStatus, updatePacket, deletePacket,
  insertIngestionRecord, getIngestionRecordByPacketId, getIngestionRecordsByPacket,
  insertSdEvent, getSdEventsByPacketId,
  insertTransaction, getCompletedPacketsWithRecords,
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

// GET /api/packets/completed-with-records
// Single JOIN query — returns completed packets with their ingestion records embedded.
// Must be declared before /:id so Express doesn't treat "completed-with-records" as an id.
router.get('/completed-with-records', async (_req: Request, res: Response) => {
  try {
    const rows = await getCompletedPacketsWithRecords()
    res.json(rows)
  } catch (err) {
    console.error('GET /api/packets/completed-with-records error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/packets
// Supports ?status=single  OR  ?statuses=a,b,c  for multi-status filtering
// Optional ?assigned_to=<name> — case-insensitive filter on assigned_to
//   (used by the Discord bot's per-ingestion-person channel /list)
//   Can be combined with ?statuses to narrow down further.
// Optional ?repack_photos=1  — include repack_photo_urls in response
//   (only needed for ready-to-ingest and collect-sdc card thumbnails)
// Optional ?limit=N          — cap number of rows (default 500 for unfiltered)
router.get('/', async (req: Request, res: Response) => {
  try {
    const status        = req.query.status        as PacketStatus | undefined
    const statuses      = req.query.statuses      as string | undefined
    const assignedTo    = req.query.assigned_to   as string | undefined
    const repackPhotos  = req.query.repack_photos === '1'
    const limitParam    = req.query.limit          as string | undefined
    const limit         = limitParam ? Math.min(Number(limitParam), 2000) : undefined

    let packets
    if (assignedTo) {
      const statusList = statuses
        ? (statuses.split(',').map(s => s.trim()).filter(Boolean) as PacketStatus[])
        : status ? [status] : undefined
      packets = await getPacketsByAssignee(assignedTo, statusList)
    } else if (statuses) {
      const list = statuses.split(',').map(s => s.trim()).filter(Boolean) as PacketStatus[]
      packets = await getPacketsByStatuses(list, { repackPhotos })
    } else {
      // For unfiltered (all-packets log view) cap at 500 rows to avoid huge payloads
      const effectiveLimit = limit ?? (status ? undefined : 500)
      packets = await getPackets(status ? { status } : undefined, { repackPhotos, limit: effectiveLimit })
    }
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
      const { team_name, received_date, poc_phones, entered_by, photo_urls } = body
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
        photo_urls:     photo_urls || null,
        entered_by:     entered_by || 'Logistics',
        poc_emails:     '',
        poc_phones:     poc_phones || '',
        status:         'received_at_hq',
      } as any)

      // Log the event
      await insertSdEvent(packet.id, 'received_at_hq', {
        team_name,
        received_date,
        poc_phones:  poc_phones || '',
        entered_by:  entered_by || 'Logistics',
        photo_urls:  photo_urls || null,
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
      event_type: 'counted_and_repacked' | 'collected_for_ingestion' | 'ingestion_started'
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

    // ── counted_and_repacked ─────────────────────────────────────────────────
    if (event_type === 'counted_and_repacked') {
      const sdCount      = Number(event_data.sd_card_count)  || 0
      const numPackages  = Number(event_data.num_packages)    || 0
      const factoryName  = String(event_data.factory_name   ?? packet.factory ?? '')
      const deployDate   = event_data.deployment_date ? String(event_data.deployment_date) : null
      const countedBy    = String(event_data.counted_by ?? 'Logistics')

      const repackPhotos = event_data.repack_photo_urls
        ? JSON.stringify(event_data.repack_photo_urls)
        : null

      // Multiple factory entries (each has factory_name + deployment_date)
      const factoryEntries = event_data.factory_entries
        ? JSON.stringify(event_data.factory_entries)
        : JSON.stringify([{ factory_name: factoryName, deployment_date: deployDate }])

      const updatedPacket = await updatePacket(id, {
        status:             'counted_and_repacked',
        sd_card_count:      sdCount,
        num_packages:       numPackages,
        factory:            factoryName,
        deployment_date:    deployDate ?? undefined,
        counted_by:         countedBy,
        repack_photo_urls:  repackPhotos ?? undefined,
        factory_entries:    factoryEntries,
      })

      // Auto-create a "received" transaction in the inventory tracker
      insertTransaction({
        team_name:       packet.team_name,
        type:            'received',
        date:            new Date().toISOString().slice(0, 10),
        devices:         0,
        sd_cards:        sdCount,
        hubs:            0,
        cables:          0,
        extension_boxes: 0,
        sd_card_readers: 0,
        other:           0,
        notes:           `Auto-logged from SD card count & repack (packet #${id})${event_data.condition_notes ? ' — ' + event_data.condition_notes : ''}`,
        entered_by:      countedBy,
      }).catch(err => console.error('auto-transaction insert failed:', err))

      waSendCountedAndRepacked(updatedPacket as any, event_data).catch(err =>
        console.error('waSendCountedAndRepacked failed:', err)
      )

      res.status(201).json({ packet: updatedPacket, event })
      return
    }

    // ── collected_for_ingestion ──────────────────────────────────────────────
    // Used by:
    //   - Discord bot /assign (in #ready_to_ingest) — ingestion lead assigns
    //     a packet to a specific ingestion person
    //   - Legacy /collect command
    if (event_type === 'collected_for_ingestion') {
      const collectedBy = String(event_data.collected_by ?? event_data.assigned_by ?? 'Ingestion')
      const assignedTo  = event_data.assigned_to ? String(event_data.assigned_to) : null
      const updatedPacket = await updatePacket(id, {
        status:       'collected_for_ingestion',
        collected_by: collectedBy,
        ...(assignedTo ? { assigned_to: assignedTo } : {}),
      })
      res.status(201).json({ packet: updatedPacket, event })
      return
    }

    // ── ingestion_started ────────────────────────────────────────────────────
    // Used by the Discord bot /start command in each ingestion person's channel.
    // Moves packet to `ingestion_started` status and stamps the starter's name.
    if (event_type === 'ingestion_started') {
      const startedBy = event_data.started_by ? String(event_data.started_by) : null
      const updatedPacket = await updatePacket(id, {
        status: 'ingestion_started',
        ...(startedBy ? { assigned_to: startedBy } : {}),
      })
      res.status(201).json({ packet: updatedPacket, event })
      return
    }

    res.status(400).json({ error: `Unknown event_type: ${event_type}` })
  } catch (err) {
    console.error(`POST /api/packets/${req.params.id}/events error:`, err)
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/packets/:id
// Returns:
//   packet             — row
//   ingestion          — legacy: first ingestion record for this packet (or null)
//   ingestion_records  — NEW: every ingestion record (one row per factory)
//   events             — full event audit trail
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const packet = await getPacketById(id)
    if (!packet) { res.status(404).json({ error: 'Not found' }); return }
    const [ingestionRecords, events] = await Promise.all([
      getIngestionRecordsByPacket(id),
      getSdEventsByPacketId(id),
    ])
    res.json({
      packet,
      ingestion:          ingestionRecords[0] ?? null,  // legacy shape
      ingestion_records:  ingestionRecords,
      events,
    })
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

    // ── update_photos — called by Discord bot after arrival/repack ────────────
    if (action === 'update_photos') {
      const { photo_urls, repack_photo_urls } = ingestionData
      const updated = await updatePacket(id, {
        ...(photo_urls        !== undefined ? { photo_urls }        : {}),
        ...(repack_photo_urls !== undefined ? { repack_photo_urls } : {}),
      })
      res.json(updated)
      return
    }

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
      // Allow completion from:
      //   - old `processing` state
      //   - logistics-pipeline `collected_for_ingestion`
      //   - newer `ingestion_started` (set by Discord /start)
      //   - `completed` — ONLY if the packet has more factories pending.
      //     This lets a multi-factory packet that was prematurely marked
      //     `completed` still accept its remaining factory completions.
      const completableStatuses = ['processing', 'collected_for_ingestion', 'ingestion_started', 'completed']
      if (!completableStatuses.includes(packet.status)) {
        res.status(400).json({ error: 'Packet cannot be completed from its current state' })
        return
      }

      const {
        team_name, actual_count, missing_count, extra_count,
        red_cards_count, ingested_by, deployment_date, notes,
      } = ingestionData

      // industry = factory for this ingestion record. Prefer an explicit
      // `industry` field, then `factory_name`, then fall back to the
      // packet's own factory column (legacy single-factory packets).
      const industry = ingestionData.industry || ingestionData.factory_name || packet.factory || 'General'

      if (!team_name || !ingested_by || !deployment_date) {
        res.status(400).json({ error: 'Missing ingestion fields' })
        return
      }

      // Parse the packet's factory_entries to know how many distinct
      // factories this packet was counted as having. De-duplicate by
      // normalised factory_name — sometimes /count accidentally records
      // the same factory twice, and we want completion math to reflect
      // the number of UNIQUE factories (one ingestion_record per name).
      type FactoryEntry = { factory_name: string; deployment_date?: string | null }
      let rawFactoryList: FactoryEntry[] = []
      try {
        const raw = JSON.parse(packet.factory_entries || '[]')
        rawFactoryList = Array.isArray(raw) ? raw : []
      } catch { /* treat as no factory list */ }

      const norm = (s: string) => String(s || '').trim().toLowerCase()

      const seenFactoryKeys = new Set<string>()
      const factoryList: FactoryEntry[] = []
      for (const f of rawFactoryList) {
        const key = norm(f.factory_name)
        if (!key || seenFactoryKeys.has(key)) continue
        seenFactoryKeys.add(key)
        factoryList.push(f)
      }

      // Multi-factory packet — require the supplied factory to match one
      // of the counted factories. Single-factory packets (or legacy
      // packets with empty factory_entries) skip this check.
      if (factoryList.length > 1) {
        const match = factoryList.find(f => norm(f.factory_name) === norm(industry))
        if (!match) {
          res.status(400).json({
            error:
              `Factory "${industry}" is not part of packet #${id}. ` +
              `Factories on this packet: ${factoryList.map(f => f.factory_name).join(', ')}`,
          })
          return
        }
      }

      // Look up everything already ingested against this packet and
      // reject a duplicate completion of the same factory.
      const existingRecords = await getIngestionRecordsByPacket(id)
      const alreadyDone     = existingRecords.find(r => norm(r.industry) === norm(industry))
      if (alreadyDone) {
        res.status(400).json({
          error: `Factory "${industry}" for packet #${id} is already completed.`,
        })
        return
      }

      // If the packet is ALREADY `completed` but the caller is trying to
      // add yet another factory, confirm there's actually something still
      // outstanding (otherwise the pipeline is truly done).
      const totalExpected = factoryList.length || 1
      if (packet.status === 'completed' && existingRecords.length >= totalExpected) {
        res.status(400).json({
          error: `All ${totalExpected} factor${totalExpected === 1 ? 'y' : 'ies'} for packet #${id} are already completed.`,
        })
        return
      }

      // Insert the ingestion record for this factory
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

      const completedCount = existingRecords.length + 1 // +1 for the row we just inserted
      const allDone        = completedCount >= totalExpected

      // Compute the human-readable list of factories that still need
      // ingestion (used by the Discord bot to prompt the user).
      const remainingFactories = factoryList
        .filter(f => norm(f.factory_name) !== norm(industry))
        .filter(f => !existingRecords.some(r => norm(r.industry) === norm(f.factory_name)))
        .map(f => f.factory_name)

      // Flip packet → completed only once every expected factory is in.
      let updatedPacket = packet
      if (allDone && packet.status !== 'completed') {
        const flipped = await updatePacketStatus(id, 'completed')
        if (flipped) updatedPacket = flipped
      }

      // Email / WhatsApp notifications fire for every factory completion
      // so each POC knows which factory just finished.
      sendIngestionCompleteEmail(updatedPacket, record).catch(err =>
        console.error('sendIngestionCompleteEmail failed:', err)
      )
      waSendIngestionComplete(updatedPacket as any, record).catch(err =>
        console.error('waSendIngestionComplete failed:', err)
      )

      res.json({
        packet:              updatedPacket,
        ingestion:           record,
        factory_completed:   industry,
        completed_factories: completedCount,
        total_factories:     totalExpected,
        all_factories_done:  allDone,
        remaining_factories: remainingFactories,
      })
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
