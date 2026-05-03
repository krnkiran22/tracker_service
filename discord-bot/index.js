require('dotenv').config()

const http = require('http')
const {
  Client, GatewayIntentBits, Events,
  REST, Routes,
} = require('discord.js')

const CLIENT_ID   = process.env.CLIENT_ID  || '1497976137345667173'
const BACKEND     = process.env.BACKEND_URL || 'https://trackerservice-production.up.railway.app'
const TRACKER_URL = 'https://sd-tracker.vercel.app'
const PORT        = Number(process.env.PORT || 3000)
// SELF_URL = this bot service's own public URL on Railway — the bot will ping
// its own /health every 14 minutes to prevent Railway's idle shutdown.
// Example: https://sd-tracker-bot-production.up.railway.app
const SELF_URL    = process.env.SELF_URL || ''

// ── Channel name config ───────────────────────────────────────────────────────
// Logistics channels (one command per channel)
const CH_ARRIVAL = 'arrival'         // only /arrival allowed here
const CH_COUNT   = 'count_repack'    // only /count allowed here
const CH_READY   = 'ready_to_ingest' // only ingestion lead /assign allowed here

// Per-ingestion-person channels: any channel whose name starts with this
// prefix is treated as an ingestion person's private workspace.
// e.g. #ingest-aslam, #ingest-naresh, #ingest-kiran
const INGEST_PREFIX = 'ingest-'

// Comma-separated Discord user IDs of ingestion leads. When set, /assign
// and the /list view inside #ready_to_ingest are restricted to these users.
// Leave unset to disable the check (useful while testing).
const INGESTION_LEAD_IDS = (process.env.INGESTION_LEAD_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean)

function isIngestionLead(userId) {
  if (!INGESTION_LEAD_IDS.length) return true // no gate configured → allow all
  return INGESTION_LEAD_IDS.includes(userId)
}

// If the channel name is `ingest-aslam`, return "aslam". Otherwise null.
function ingestPersonFromChannel(channelName) {
  if (!channelName || !channelName.toLowerCase().startsWith(INGEST_PREFIX)) return null
  const name = channelName.slice(INGEST_PREFIX.length).trim()
  return name || null
}

// ── API helper ────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res  = await fetch(`${BACKEND}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'API error')
  return data
}

// Download a Discord attachment → base64 data URL
async function toBase64(att) {
  const res  = await fetch(att.url)
  const buf  = await res.arrayBuffer()
  const b64  = Buffer.from(buf).toString('base64')
  const mime = att.contentType || 'image/jpeg'
  return `data:${mime};base64,${b64}`
}

// Extract image attachments from a message → base64 list
async function extractPhotos(msg) {
  const images = [...msg.attachments.values()].filter(a => a.contentType?.startsWith('image/'))
  if (!images.length) return []
  return Promise.all(images.map(toBase64))
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

// Parse "Key: Value" lines into an object
function parseKV(lines) {
  const out = {}
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase().replace(/\s+/g, '_')
    const val = line.slice(idx + 1).trim()
    if (val) out[key] = val
  }
  return out
}

// Accepts either "42" or "packet:42" after a command name
function extractPacketId(first, commandName) {
  const re = new RegExp(`^/${commandName}\\s+(?:packet\\s*:\\s*)?(\\d+)`, 'i')
  const m = first.match(re)
  return m ? Number(m[1]) : null
}

function packetSummaryLine(p) {
  let entries = []
  try { entries = JSON.parse(p.factory_entries || '[]') } catch {}
  const factoryInfo = entries.length
    ? entries.map(e => `${e.factory_name}: ${e.count || 0}`).join(', ')
    : `${p.sd_card_count || 0} cards`
  const pkgs  = p.num_packages ? ` · 📦 ${p.num_packages} pkg` : ''
  const asgn  = p.assigned_to ? ` · 👤 ${p.assigned_to}` : ''
  return `**#${p.id}** · **${p.team_name}** · ${factoryInfo}${pkgs}${asgn}`
}

// ── Slash command definitions ─────────────────────────────────────────────────
const COMMANDS = [
  { name: 'list', description: '📋 List packets relevant to this channel' },
  { name: 'help', description: '📖 Show the message template for this channel' },
]

async function registerCommands(client) {
  const rest   = new REST().setToken(process.env.DISCORD_TOKEN)
  const guilds = client.guilds.cache.map(g => g.id)
  for (const guildId of guilds) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: COMMANDS })
    console.log(`✅ Slash commands registered in guild ${guildId}`)
  }
  if (!guilds.length) {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: COMMANDS })
    console.log('✅ Slash commands registered globally')
  }
}

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

// Track when the bot came online so the health-ping reply can show uptime.
let botStartedAt = null

client.once(Events.ClientReady, async (c) => {
  botStartedAt = new Date()
  console.log(`✅ Bot online as ${c.user.tag}`)
  await registerCommands(c)
})

// Human-friendly "2h 15m 30s" from a ms duration.
function formatUptime(ms) {
  const total = Math.floor(ms / 1000)
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  parts.push(`${s}s`)
  return parts.join(' ')
}

// Check if a raw message is a bot-health ping — i.e. the bot is @-mentioned
// and (after stripping the mention) the leftover text is empty or a short
// greeting like "hi", "hey", "ping", "are you up?".
function isHealthPing(msg, botId) {
  if (!msg.mentions?.has?.(botId)) return false
  // Strip the <@botId> token and any surrounding whitespace/punctuation
  const stripped = msg.content
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .trim()
    .toLowerCase()
    .replace(/[!?.,]+$/, '')
  if (!stripped) return true // pure mention
  if (stripped.startsWith('/')) return false // leave commands alone
  const greetings = [
    'hi', 'hii', 'hiii', 'hello', 'hey', 'heyy', 'yo',
    'ping', 'alive', 'status', 'health', 'up',
    'are you up', 'are you alive', 'are you there', 'you there',
    'sup', 'hola',
  ]
  return greetings.some(g => stripped === g || stripped.startsWith(g + ' '))
}

// ══════════════════════════════════════════════════════════════════════════════
// /list — channel-aware
//   #count_repack      → packets pending count & repack (received_at_hq)
//   #ready_to_ingest   → packets ready to assign (counted_and_repacked)
//                        restricted to ingestion leads
//   #ingest-<name>     → packets assigned to <name>
//                        (collected_for_ingestion + ingestion_started)
// ══════════════════════════════════════════════════════════════════════════════
async function handleListCommand(interaction) {
  // ACK within 3s no matter what — avoids "The application did not respond"
  // even if the bot just woke from a Railway cold start or the backend is slow.
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply()
  }

  const chName  = interaction.channel?.name || ''
  const chLower = chName.toLowerCase()

  // ── #count_repack ───────────────────────────────────────────────────────────
  if (chLower === CH_COUNT) {
    try {
      const packets = await api('/api/packets?status=received_at_hq')
      if (!packets.length) {
        await interaction.editReply('✅ No packets pending Count & Repack.')
        return
      }
      const lines = packets.map(p =>
        `**#${p.id}** · **${p.team_name}** · received ${fmtDate(p.date_received)}${p.entered_by ? ` · by ${p.entered_by}` : ''}`
      ).join('\n')
      await interaction.editReply(
        `📋 **Packets Pending Count & Repack** (${packets.length})\n\n${lines}\n\n` +
        `▶️ Send \`/count 42\` + factory lines to count a packet`
      )
    } catch (err) {
      await interaction.editReply(`❌ ${err.message}`)
    }
    return
  }

  // ── #ready_to_ingest (ingestion lead only) ──────────────────────────────────
  if (chLower === CH_READY) {
    if (!isIngestionLead(interaction.user.id)) {
      await interaction.editReply(`❌ Only ingestion leads can use \`/list\` here.`)
      return
    }
    try {
      const packets = await api('/api/packets?status=counted_and_repacked&repack_photos=1')
      if (!packets.length) {
        await interaction.editReply('✅ No packets ready to assign.')
        return
      }
      const lines = packets.map(packetSummaryLine).join('\n')
      await interaction.editReply(
        `🚀 **Packets Ready to Assign** (${packets.length})\n\n${lines}\n\n` +
        `▶️ Assign with:\n\`\`\`\n/assign 42\nTeam: Dukaan\nCount: 192\nAssign to: Aslam\nDate: ${today()}\n\`\`\``
      )
    } catch (err) {
      await interaction.editReply(`❌ ${err.message}`)
    }
    return
  }

  // ── #ingest-<name> (per-ingestion-person queue) ─────────────────────────────
  const person = ingestPersonFromChannel(chLower)
  if (person) {
    try {
      const packets = await api(
        `/api/packets?assigned_to=${encodeURIComponent(person)}` +
        `&statuses=collected_for_ingestion,ingestion_started`
      )
      if (!packets.length) {
        await interaction.editReply(`✅ No packets currently assigned to **${person}**.`)
        return
      }
      const lines = packets.map(p => {
        const badge = p.status === 'ingestion_started' ? '⏳ in progress'
                    : '📦 assigned'
        return `**#${p.id}** · **${p.team_name}** · ${p.sd_card_count || 0} cards · ${badge}`
      }).join('\n')
      await interaction.editReply(
        `📋 **Packets assigned to ${person}** (${packets.length})\n\n${lines}\n\n` +
        `▶️ Start with \`/start 42\` + details\n` +
        `▶️ Finish with \`/complete 42\` + counts`
      )
    } catch (err) {
      await interaction.editReply(`❌ ${err.message}`)
    }
    return
  }

  // ── Any other channel — show a hint ─────────────────────────────────────────
  await interaction.editReply(
    `ℹ️ \`/list\` needs to be used in one of:\n` +
    `• **#${CH_COUNT}** — packets pending count\n` +
    `• **#${CH_READY}** — packets ready to assign (ingestion lead)\n` +
    `• **#${INGEST_PREFIX}<your-name>** — packets assigned to you`
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// /help — channel-aware template display
// ══════════════════════════════════════════════════════════════════════════════
async function handleHelpCommand(interaction) {
  // ACK immediately so we never miss the 3s window.
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply()
  }

  const ch = (interaction.channel?.name || '').toLowerCase()

  if (ch === CH_ARRIVAL) {
    await interaction.editReply(
      `**📦 #arrival — Log a new SD card packet**\n\n` +
      `Send a message in this format:\n` +
      `\`\`\`\n/arrival\nTeam: Dukaan\nReceived by: Naresh\nPhone: 9876543210\nDate: ${today()}\n\`\`\`` +
      `\n\n_Phone and Date are optional. Attach photos to the same message._`
    )
    return
  }

  if (ch === CH_COUNT) {
    await interaction.editReply(
      `**✅ #count_repack — Count & Repack a packet**\n\n` +
      `First use \`/list\` to get the packet ID, then send:\n` +
      `\`\`\`\n/count 42\nFactory Name,YYYY-MM-DD,SD Count,Missing,Packages\nCounted by: Naresh\nNotes: optional\n\`\`\`` +
      `\n\n**Example:**\n` +
      `\`\`\`\n/count 42\nDyna Fashion,2026-04-25,192,3,2\nAttire,2026-04-25,37,0,1\nCounted by: Naresh\n\`\`\`` +
      `\n\n_Add as many factory lines as needed. Attach photos to the same message._`
    )
    return
  }

  if (ch === CH_READY) {
    await interaction.editReply(
      `**🚀 #ready_to_ingest — Assign a packet (ingestion lead only)**\n\n` +
      `First use \`/list\` to see packets awaiting assignment, then send:\n` +
      `\`\`\`\n/assign 42\nTeam: Dukaan\nCount: 192\nAssign to: Aslam\nDate: ${today()}\n\`\`\`` +
      `\n\n_The assignee will see the packet in their own **#${INGEST_PREFIX}<name>** channel._`
    )
    return
  }

  const person = ingestPersonFromChannel(ch)
  if (person) {
    await interaction.editReply(
      `**🎯 #${INGEST_PREFIX}${person} — Your ingestion queue**\n\n` +
      `\`/list\` — show packets assigned to you\n\n` +
      `**When you start a packet:**\n` +
      `\`\`\`\n/start 42\nTeam: Dukaan\nDeployment date: ${today()}\nFactory: Dyna Fashion\nCount: 192\nDate: ${today()}\n\`\`\`` +
      `\n\n**When you finish a packet:**\n` +
      `\`\`\`\n/complete 42\nDeployment date: ${today()}\nTeam: Dukaan\nFactory: Dyna Fashion\nCount: 190\nMissing: 2\nExtra: 0\nRed: 1\n\`\`\`` +
      `\n\n_Attach photos to the same message — they'll be saved against the packet._`
    )
    return
  }

  // Generic fallback
  await interaction.editReply(
    `**📖 SD Tracker Bot — Channel Guide**\n\n` +
    `**#${CH_ARRIVAL}** → \`/arrival\` + team/received by/phone/date\n` +
    `**#${CH_COUNT}** → \`/count <id>\` + factory lines\n` +
    `**#${CH_READY}** → \`/assign <id>\` + team/count/assign to/date _(lead only)_\n` +
    `**#${INGEST_PREFIX}<name>** → \`/start <id>\` and \`/complete <id>\`\n\n` +
    `**Slash commands:**\n` +
    `\`/list\` — channel-aware list\n` +
    `\`/help\` — show this channel's template`
  )
}

// ── Slash command dispatcher ──────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return
  try {
    if (interaction.commandName === 'list') return handleListCommand(interaction)
    if (interaction.commandName === 'help') return handleHelpCommand(interaction)
  } catch (err) {
    console.error(`Slash /${interaction.commandName} failed:`, err)
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`❌ ${err.message}`)
    } else {
      await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true })
    }
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// Message command handler
// Handles: /arrival, /count <id>, /assign <id>, /start <id>, /complete <id>
// Photos can be attached to the SAME message — no need to reply separately.
// Also handles reply-with-photos as a fallback (photoPending map).
// ══════════════════════════════════════════════════════════════════════════════
const photoPending = new Map() // replyMsgId → { packetId, type }

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return

  // ══════════════════════════════════════════════════════════════════════════
  // Health ping — @-mention the bot with an empty message or a greeting like
  // "hi", "hey", "are you up?" and it replies confirming it's alive + uptime.
  // Works in every channel. Must come first so it doesn't get shadowed by
  // the command handlers below.
  // ══════════════════════════════════════════════════════════════════════════
  if (client.user && isHealthPing(msg, client.user.id)) {
    const uptime = botStartedAt
      ? formatUptime(Date.now() - botStartedAt.getTime())
      : 'just now'
    try {
      await msg.reply(
        `👋 Yes, I'm still up and working!\n` +
        `⏱️ Uptime: **${uptime}** · 🛰️ Gateway ping: **${client.ws.ping}ms**\n` +
        `▶️ Run \`/help\` in any channel to see what I can do here.`
      )
    } catch (err) {
      console.warn('health ping reply failed:', err.message)
    }
    return
  }

  const text  = msg.content.trim()
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return

  const first  = lines[0]
  const chName = (msg.channel?.name || '').toLowerCase()

  // ══════════════════════════════════════════════════════════════════════════
  // /arrival — #arrival channel
  // Template:
  //   /arrival
  //   Team: Dukaan
  //   Received by: Naresh
  //   Phone: 9876543210        (optional)
  //   Date: 2026-04-25         (optional, defaults to today)
  // ══════════════════════════════════════════════════════════════════════════
  if (first.toLowerCase() === '/arrival') {
    if (chName !== CH_ARRIVAL) {
      await msg.reply(`❌ Use \`/arrival\` only in the **#${CH_ARRIVAL}** channel.`)
      return
    }
    const kv          = parseKV(lines.slice(1))
    const team_name   = kv['team'] || kv['team_name']
    const received_by = kv['received_by'] || kv['received by'] || kv['by']
    const phone       = kv['phone'] || kv['whatsapp'] || ''
    const date_raw    = kv['date'] || kv['received_date'] || kv['date_received'] || ''
    const date        = date_raw || today()

    const arrivalErrors = []
    if (!team_name)   arrivalErrors.push(`• **Team** is missing — add a line: \`Team: Dukaan\``)
    if (!received_by) arrivalErrors.push(`• **Received by** is missing — add a line: \`Received by: Naresh\``)

    if (arrivalErrors.length) {
      await msg.reply(
        `❌ **Fix these issues and try again:**\n${arrivalErrors.join('\n')}\n\n` +
        `**Full format:**\n\`\`\`\n/arrival\nTeam: Dukaan\nReceived by: Naresh\nPhone: 9876543210\nDate: ${today()}\n\`\`\`\n_(Phone and Date are optional)_`
      )
      return
    }

    try {
      const photos = await extractPhotos(msg)

      const packet = await api('/api/packets', {
        method: 'POST',
        body: JSON.stringify({
          team_name,
          received_date: date,
          entered_by:    received_by,
          poc_phones:    phone,
          photo_urls:    photos.length ? JSON.stringify(photos) : null,
        }),
      })

      const photoNote = photos.length
        ? `📸 ${photos.length} photo(s) saved.`
        : `📸 Reply to this message with photos to attach them.`

      const reply = await msg.reply(
        `✅ **Packet #${packet.id} logged!**\n` +
        `📦 Team: **${team_name}** · Received by: **${received_by}**` +
        (phone ? ` · 📱 ${phone}` : '') +
        ` · 📅 ${fmtDate(date)}\n\n` +
        photoNote + `\n\n` +
        `▶️ It'll show up in \`/list\` inside **#${CH_COUNT}**`
      )

      if (!photos.length) {
        photoPending.set(reply.id, { packetId: packet.id, type: 'arrival' })
        setTimeout(() => photoPending.delete(reply.id), 15 * 60 * 1000)
      }
    } catch (err) {
      await msg.reply(`❌ Failed to log arrival: ${err.message}`)
    }
    return
  }

  // ══════════════════════════════════════════════════════════════════════════
  // /count <id> — #count_repack channel
  // Template:
  //   /count 42
  //   Factory Name,YYYY-MM-DD,SD Count,Missing,Packages
  //   Factory Name,YYYY-MM-DD,SD Count,Missing,Packages
  //   Counted by: Naresh
  //   Notes: optional condition notes
  // ══════════════════════════════════════════════════════════════════════════
  const countId = extractPacketId(first, 'count')
  if (countId !== null) {
    if (chName !== CH_COUNT) {
      await msg.reply(`❌ Use \`/count\` only in the **#${CH_COUNT}** channel.`)
      return
    }
    const packetId        = countId
    const factory_entries = []
    const parseErrors     = []
    let counted_by        = ''
    let notes             = ''

    let lineNum = 1
    for (const line of lines.slice(1)) {
      lineNum++
      if (line.toLowerCase().startsWith('counted by:') || line.toLowerCase().startsWith('counted_by:')) {
        counted_by = line.split(':').slice(1).join(':').trim()
        continue
      }
      if (line.toLowerCase().startsWith('notes:') || line.toLowerCase().startsWith('note:')) {
        notes = line.split(':').slice(1).join(':').trim()
        continue
      }
      if (!line.includes(',')) continue // skip non-factory lines

      const parts        = line.split(',').map(s => s.trim())
      const [factory_name, deployment_date, rawSd, rawMissing, rawPkg] = parts
      const count        = Number(rawSd)      || 0
      const missing      = Number(rawMissing) || 0
      const num_packages = Number(rawPkg)     || 1

      const lineErrors = []
      if (!factory_name)                              lineErrors.push('factory name is empty')
      if (!deployment_date)                           lineErrors.push('date is missing')
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(deployment_date)) lineErrors.push(`date \`${deployment_date}\` is invalid — use YYYY-MM-DD`)
      if (!rawSd || isNaN(Number(rawSd)))             lineErrors.push(`SD count \`${rawSd || '(empty)'}\` is not a number`)
      else if (count <= 0)                            lineErrors.push('SD count must be greater than 0')
      if (rawMissing && isNaN(Number(rawMissing)))    lineErrors.push(`missing count \`${rawMissing}\` is not a number`)
      if (rawPkg && isNaN(Number(rawPkg)))            lineErrors.push(`packages \`${rawPkg}\` is not a number`)

      if (lineErrors.length) {
        parseErrors.push(`⚠️ Line ${lineNum} \`${line}\`\n   → ${lineErrors.join(', ')}`)
        continue
      }
      factory_entries.push({ factory_name, deployment_date, count, missing, num_packages })
    }

    if (!factory_entries.length) {
      const errorBlock = parseErrors.length ? `\n\n**Issues found:**\n${parseErrors.join('\n')}` : ''
      await msg.reply(
        `❌ No valid factory lines found.${errorBlock}\n\n` +
        `**Format per factory line:**\n\`\`\`\nFactory Name,YYYY-MM-DD,SD Count,Missing,Packages\n\`\`\`` +
        `**Example:**\n\`\`\`\n/count 42\nDyna Fashion,2026-04-25,192,3,2\nAttire,2026-04-25,37,0,1\nCounted by: Naresh\n\`\`\``
      )
      return
    }

    if (!counted_by) {
      await msg.reply(
        `❌ **Missing "Counted by" line.**\n\nAdd this at the end of your message:\n\`Counted by: Naresh\``
      )
      return
    }

    const total_sd   = factory_entries.reduce((s, f) => s + f.count, 0)
    const total_pkgs = factory_entries.reduce((s, f) => s + f.num_packages, 0)

    try {
      const photos = await extractPhotos(msg)

      await api(`/api/packets/${packetId}/events`, {
        method: 'POST',
        body: JSON.stringify({
          event_type: 'counted_and_repacked',
          event_data: {
            sd_card_count:     total_sd,
            num_packages:      total_pkgs,
            factory_entries,
            condition_notes:   notes || null,
            counted_by,
            repack_photo_urls: photos.length ? photos : [],
          },
        }),
      })

      const factoryLines = factory_entries.map(f =>
        `  🏭 **${f.factory_name}** · 📅 ${f.deployment_date} · 💾 ${f.count} SD` +
        (f.missing > 0 ? ` · ⚠️ ${f.missing} missing` : '') +
        ` · 📦 ${f.num_packages} pkg`
      ).join('\n')

      const photoNote = photos.length
        ? `📸 ${photos.length} photo(s) saved.`
        : `📸 Reply to this message with photos to attach them.`

      const warnBlock = parseErrors.length ? `\n\n${parseErrors.join('\n')}` : ''

      const reply = await msg.reply(
        `✅ **Packet #${packetId} counted & repacked!**\n` +
        `👤 Counted by **${counted_by}** · ${factory_entries.length} factor${factory_entries.length === 1 ? 'y' : 'ies'}\n\n` +
        `${factoryLines}\n\n` +
        `**Total:** 💾 ${total_sd} SD cards · 📦 ${total_pkgs} pkg` +
        warnBlock + `\n\n` +
        photoNote + `\n\n` +
        `▶️ Ingestion lead can now \`/assign\` it inside **#${CH_READY}**`
      )

      if (!photos.length) {
        photoPending.set(reply.id, { packetId, type: 'repack' })
        setTimeout(() => photoPending.delete(reply.id), 15 * 60 * 1000)
      }
    } catch (err) {
      await msg.reply(`❌ Failed: ${err.message}`)
    }
    return
  }

  // ══════════════════════════════════════════════════════════════════════════
  // /assign <id> — #ready_to_ingest channel (ingestion lead only)
  // Template:
  //   /assign 42
  //   Team: Dukaan
  //   Count: 192
  //   Assign to: Aslam
  //   Date: 2026-04-26
  // ══════════════════════════════════════════════════════════════════════════
  const assignId = extractPacketId(first, 'assign')
  if (assignId !== null) {
    if (chName !== CH_READY) {
      await msg.reply(`❌ Use \`/assign\` only in the **#${CH_READY}** channel.`)
      return
    }
    if (!isIngestionLead(msg.author.id)) {
      await msg.reply(`❌ Only ingestion leads can assign packets.`)
      return
    }

    const packetId    = assignId
    const kv          = parseKV(lines.slice(1))
    const team_name   = kv['team']        || kv['team_name']
    const count       = kv['count']       || kv['sd_count'] || kv['sd_card_count']
    const assign_to   = kv['assign_to']   || kv['assign to'] || kv['assignee'] || kv['to']
    const date_raw    = kv['date']        || kv['assigned_date'] || kv['assign_date'] || ''
    const date        = date_raw || today()

    const assignErrors = []
    if (!team_name) assignErrors.push(`• **Team** is missing — add: \`Team: Dukaan\``)
    if (!assign_to) assignErrors.push(`• **Assign to** is missing — add: \`Assign to: Aslam\``)

    if (assignErrors.length) {
      await msg.reply(
        `❌ **Fix these issues and try again:**\n${assignErrors.join('\n')}\n\n` +
        `**Full format:**\n\`\`\`\n/assign 42\nTeam: Dukaan\nCount: 192\nAssign to: Aslam\nDate: ${today()}\n\`\`\``
      )
      return
    }

    try {
      const photos = await extractPhotos(msg)

      await api(`/api/packets/${packetId}/events`, {
        method: 'POST',
        body: JSON.stringify({
          event_type: 'collected_for_ingestion',
          event_data: {
            assigned_to:  assign_to,
            assigned_by:  msg.author.username || 'Ingestion Lead',
            team_name:    team_name || null,
            sd_card_count: count ? Number(count) : null,
            assigned_date: date,
            photos:       photos.length ? photos : undefined,
          },
        }),
      })

      const countNote = count ? ` · 💾 ${count} cards` : ''
      const photoNote = photos.length ? `\n📸 ${photos.length} photo(s) attached.` : ''

      await msg.reply(
        `✅ **Packet #${packetId} assigned!**\n` +
        `📦 **${team_name}**${countNote} · 👤 **${assign_to}** · 📅 ${fmtDate(date)}${photoNote}\n\n` +
        `▶️ **${assign_to}** — check \`/list\` inside your **#${INGEST_PREFIX}${assign_to.toLowerCase().split(/\s+/)[0]}** channel.`
      )
    } catch (err) {
      await msg.reply(`❌ Failed: ${err.message}`)
    }
    return
  }

  // ══════════════════════════════════════════════════════════════════════════
  // /start <id> — #ingest-<name> channel
  // Template:
  //   /start 42
  //   Team: Dukaan
  //   Deployment date: 2026-04-26
  //   Factory: Dyna Fashion
  //   Count: 192
  //   Date: 2026-04-26
  // ══════════════════════════════════════════════════════════════════════════
  const startId = extractPacketId(first, 'start')
  if (startId !== null) {
    const person = ingestPersonFromChannel(chName)
    if (!person) {
      await msg.reply(`❌ Use \`/start\` only inside your personal **#${INGEST_PREFIX}<name>** channel.`)
      return
    }
    const packetId        = startId
    const kv              = parseKV(lines.slice(1))
    const team_name       = kv['team']             || kv['team_name']
    const deployment_date = kv['deployment_date']  || kv['deployment date'] || kv['deploy_date'] || ''
    const factory_name    = kv['factory']          || kv['factory_name']
    const count           = kv['count']            || kv['sd_count']        || kv['sd_card_count']
    const date_raw        = kv['date']             || kv['start_date']      || ''
    const date            = date_raw || today()

    const startErrors = []
    if (!team_name)       startErrors.push(`• **Team** is missing — add: \`Team: Dukaan\``)
    if (!factory_name)    startErrors.push(`• **Factory** is missing — add: \`Factory: Dyna Fashion\``)
    if (!deployment_date) startErrors.push(`• **Deployment date** is missing — add: \`Deployment date: ${today()}\``)

    if (startErrors.length) {
      await msg.reply(
        `❌ **Fix these issues and try again:**\n${startErrors.join('\n')}\n\n` +
        `**Full format:**\n\`\`\`\n/start 42\nTeam: Dukaan\nDeployment date: ${today()}\nFactory: Dyna Fashion\nCount: 192\nDate: ${today()}\n\`\`\``
      )
      return
    }

    try {
      const photos = await extractPhotos(msg)

      await api(`/api/packets/${packetId}/events`, {
        method: 'POST',
        body: JSON.stringify({
          event_type: 'ingestion_started',
          event_data: {
            started_by:      person,
            team_name,
            factory_name,
            deployment_date,
            sd_card_count:   count ? Number(count) : null,
            started_date:    date,
            photos:          photos.length ? photos : undefined,
          },
        }),
      })

      const countNote = count ? ` · 💾 ${count} cards` : ''
      const photoNote = photos.length ? `\n📸 ${photos.length} photo(s) attached.` : ''

      await msg.reply(
        `⏳ **Packet #${packetId} ingestion started!**\n` +
        `👤 ${person} · 📦 **${team_name}** · 🏭 ${factory_name}${countNote} · 📅 deploy ${fmtDate(deployment_date)}${photoNote}\n\n` +
        `▶️ When you're done, send \`/complete ${packetId}\` with the final counts.`
      )
    } catch (err) {
      await msg.reply(`❌ Failed: ${err.message}`)
    }
    return
  }

  // ══════════════════════════════════════════════════════════════════════════
  // /complete <id> — #ingest-<name> channel
  // Template:
  //   /complete 42
  //   Deployment date: 2026-04-26
  //   Team: Dukaan
  //   Factory: Dyna Fashion
  //   Count: 190
  //   Missing: 2
  //   Extra: 0
  //   Red: 1
  // ══════════════════════════════════════════════════════════════════════════
  const completeId = extractPacketId(first, 'complete')
  if (completeId !== null) {
    const person = ingestPersonFromChannel(chName)
    if (!person) {
      await msg.reply(`❌ Use \`/complete\` only inside your personal **#${INGEST_PREFIX}<name>** channel.`)
      return
    }
    const packetId        = completeId
    const kv              = parseKV(lines.slice(1))
    const deployment_date = kv['deployment_date']  || kv['deployment date'] || kv['deploy_date'] || ''
    const team_name       = kv['team']             || kv['team_name']
    const factory_name    = kv['factory']          || kv['factory_name']    || kv['industry']
    const rawCount        = kv['count']            || kv['actual_count']    || kv['sd_count']   || '0'
    const rawMissing      = kv['missing']          || kv['missing_count']   || '0'
    const rawExtra        = kv['extra']            || kv['extra_count']     || '0'
    const rawRed          = kv['red']              || kv['red_cards']       || kv['red_count']  || '0'

    const errors = []
    if (!team_name)       errors.push(`• **Team** is missing — add: \`Team: Dukaan\``)
    if (!deployment_date) errors.push(`• **Deployment date** is missing — add: \`Deployment date: ${today()}\``)
    if (!factory_name)    errors.push(`• **Factory** is missing — add: \`Factory: Dyna Fashion\``)
    if (isNaN(Number(rawCount)))   errors.push(`• **Count** \`${rawCount}\` is not a number`)
    if (isNaN(Number(rawMissing))) errors.push(`• **Missing** \`${rawMissing}\` is not a number`)
    if (isNaN(Number(rawExtra)))   errors.push(`• **Extra** \`${rawExtra}\` is not a number`)
    if (isNaN(Number(rawRed)))     errors.push(`• **Red** \`${rawRed}\` is not a number`)

    if (errors.length) {
      await msg.reply(
        `❌ **Fix these issues and try again:**\n${errors.join('\n')}\n\n` +
        `**Full format:**\n\`\`\`\n/complete 42\nDeployment date: ${today()}\nTeam: Dukaan\nFactory: Dyna Fashion\nCount: 190\nMissing: 2\nExtra: 0\nRed: 1\n\`\`\``
      )
      return
    }

    try {
      const photos = await extractPhotos(msg)

      // Attach photos by updating repack_photo_urls on the packet first
      // (if any new ones are provided) so they surface in the UI.
      if (photos.length) {
        await api(`/api/packets/${packetId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            action: 'update_photos',
            repack_photo_urls: JSON.stringify(photos),
          }),
        }).catch(err => console.warn(`update_photos for #${packetId} failed: ${err.message}`))
      }

      await api(`/api/packets/${packetId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action:          'complete',
          team_name,
          industry:        factory_name,
          actual_count:    Number(rawCount),
          missing_count:   Number(rawMissing),
          extra_count:     Number(rawExtra),
          red_cards_count: Number(rawRed),
          ingested_by:     person,
          deployment_date,
        }),
      })

      // Also log an event row so the Activity Log picks it up
      await api(`/api/packets/${packetId}/events`, {
        method: 'POST',
        body: JSON.stringify({
          event_type: 'ingestion_completed',
          event_data: {
            ingested_by:     person,
            team_name,
            factory_name,
            actual_count:    Number(rawCount),
            missing_count:   Number(rawMissing),
            extra_count:     Number(rawExtra),
            red_cards_count: Number(rawRed),
            deployment_date,
          },
        }),
      }).catch(err => console.warn(`event log for completion #${packetId} failed: ${err.message}`))

      const photoNote = photos.length ? `\n📸 ${photos.length} photo(s) attached.` : ''

      await msg.reply(
        `✅ **Packet #${packetId} ingestion complete!**\n` +
        `👤 ${person} · 📦 **${team_name}** · 🏭 ${factory_name}\n` +
        `💾 ${rawCount} actual · ⚠️ ${rawMissing} missing · ➕ ${rawExtra} extra · 🔴 ${rawRed} red\n` +
        `📅 Deployed ${fmtDate(deployment_date)}${photoNote}\n\n` +
        `🔗 ${TRACKER_URL}`
      )
    } catch (err) {
      await msg.reply(`❌ Failed: ${err.message}`)
    }
    return
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Photo reply fallback — reply to a bot confirmation with images attached
  // ══════════════════════════════════════════════════════════════════════════
  if (msg.reference?.messageId) {
    const pending = photoPending.get(msg.reference.messageId)
    if (!pending) return

    const images = [...msg.attachments.values()].filter(a => a.contentType?.startsWith('image/'))
    if (!images.length) return

    try {
      const statusMsg  = await msg.reply(`⏳ Saving ${images.length} photo(s)…`)
      const base64List = await Promise.all(images.map(toBase64))
      const { packetId, type } = pending

      await api(`/api/packets/${packetId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'update_photos',
          ...(type === 'repack'
            ? { repack_photo_urls: JSON.stringify(base64List) }
            : { photo_urls: JSON.stringify(base64List) }
          ),
        }),
      })

      photoPending.delete(msg.reference.messageId)
      await statusMsg.edit(`✅ ${images.length} photo(s) saved to packet #${packetId}!`)
    } catch (err) {
      await msg.reply(`❌ Failed to save photos: ${err.message}`)
    }
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// Keep-alive HTTP server
// Railway sleeps services without inbound HTTP traffic. Discord's WebSocket
// alone isn't enough to keep the container awake, so we:
//   1. Expose a tiny HTTP /health endpoint on $PORT (Railway sets this)
//   2. Self-ping that endpoint every 14 minutes (same pattern the main
//      backend uses in src/index.ts)
//   3. Also ping the main backend's /health so both services keep each
//      other warm — useful when the bot talks to a cold backend.
// ══════════════════════════════════════════════════════════════════════════════
const keepAliveServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const uptimeMs = botStartedAt ? Date.now() - botStartedAt.getTime() : 0
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok:         true,
      bot_ready:  client.isReady(),
      uptime_ms:  uptimeMs,
      uptime:     formatUptime(uptimeMs),
      gateway_ping: client.ws?.ping ?? null,
      ts:         new Date().toISOString(),
    }))
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
})

keepAliveServer.listen(PORT, () => {
  console.log(`✓ Keep-alive HTTP server listening on :${PORT}`)
})

function startKeepAlive() {
  const INTERVAL_MS = 14 * 60 * 1000 // 14 minutes

  setInterval(async () => {
    // Ping ourselves (only if SELF_URL is configured)
    if (SELF_URL) {
      try {
        const res = await fetch(`${SELF_URL.replace(/\/$/, '')}/health`)
        console.log(`[keep-alive] self /health → ${res.status}`)
      } catch (err) {
        console.warn(`[keep-alive] self ping failed:`, err.message)
      }
    }
    // Also ping the main backend so it stays warm for our API calls
    try {
      const res = await fetch(`${BACKEND}/health`)
      console.log(`[keep-alive] backend /health → ${res.status}`)
    } catch (err) {
      console.warn(`[keep-alive] backend ping failed:`, err.message)
    }
  }, INTERVAL_MS)

  console.log(
    `✓ Keep-alive pinging ` +
    (SELF_URL ? `${SELF_URL}/health + ` : `(SELF_URL not set) `) +
    `${BACKEND}/health every 14 min`
  )
}

startKeepAlive()

client.login(process.env.DISCORD_TOKEN)
