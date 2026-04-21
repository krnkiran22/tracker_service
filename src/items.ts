export const ITEMS = [
  { key: 'devices',         label: 'Device'    },
  { key: 'sd_cards',        label: 'SD Card'   },
  { key: 'hubs',            label: 'Hub'       },
  { key: 'cables',          label: 'Cables'    },
  { key: 'extension_boxes', label: 'Ext. Box'  },
  { key: 'sd_card_readers', label: 'SD Reader' },
  { key: 'other',           label: 'Other'     },
] as const

export type ItemKey = typeof ITEMS[number]['key']

export interface Transaction {
  id?: number
  team_name: string
  type: 'sent' | 'received'
  date: string
  devices: number
  sd_cards: number
  hubs: number
  cables: number
  extension_boxes: number
  sd_card_readers: number
  other: number
  other_description?: string | null
  photo_url?: string | null
  notes?: string | null
  entered_by?: string | null
  created_at?: string
}
