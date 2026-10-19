import type { Space } from './types'

// Site registry: the single place that ties the physical resort (traced from
// the satellite image) to the twin ids the HMS data is keyed on.
// Coordinates are in pixels of the 784×806 traced image; px() converts to
// metres (≈0.4 m/px) centred on the main block. Replace with drone-survey
// coordinates in Phase 2 without touching anything else.

export const M_PER_PX = 0.4
const ORIGIN = [440, 500] as const

export type V2 = [number, number]
export const px = (x: number, y: number): V2 => [(x - ORIGIN[0]) * M_PER_PX, (y - ORIGIN[1]) * M_PER_PX]
const rect = (x1: number, y1: number, x2: number, y2: number): V2[] =>
  [px(x1, y1), px(x2, y1), px(x2, y2), px(x1, y2)]
const poly = (pts: number[][]): V2[] => pts.map(([x, y]) => px(x, y))

export type GroundKind = 'lawn' | 'field' | 'plot' | 'paved' | 'deck'
export interface GroundPatch { kind: GroundKind; poly: V2[]; spaceId?: string }

export type Roof = 'flat' | 'hip' | 'canopy'
export interface Building {
  id: string
  spaceId?: string
  label: string
  poly: V2[]            // footprint (convex, clockwise in image space)
  height: number        // wall height in metres
  roof: Roof
  roofColor: number
  wallColor: number
}

export const SITE = {
  bounds: { min: px(0, 0), max: px(784, 806) },

  ground: <GroundPatch[]>[
    { kind: 'plot', poly: poly([[0, 250], [108, 262], [112, 470], [96, 500], [0, 500]]) },
    { kind: 'field', spaceId: 'GROUND-NORTH', poly: poly([[118, 140], [298, 128], [298, 388], [150, 392], [118, 300]]) },
    { kind: 'field', spaceId: 'GROUND-CRICKET', poly: rect(306, 166, 430, 366) },
    { kind: 'plot', poly: poly([[642, 318], [784, 328], [784, 452], [652, 452]]) },
    { kind: 'lawn', spaceId: 'LAWN-GRAND', poly: poly([[548, 470], [692, 464], [732, 540], [722, 648], [642, 690], [562, 662], [548, 560]]) },
    { kind: 'lawn', spaceId: 'LAWN-GARDEN', poly: poly([[282, 502], [384, 506], [384, 586], [286, 582]]) },
    { kind: 'deck', spaceId: 'POOL', poly: poly([[690, 488], [742, 466], [784, 474], [784, 548], [744, 552], [700, 538]]) },
  ],

  pool: poly([[702, 497], [740, 480], [780, 486], [781, 530], [750, 541], [712, 529]]),

  // Internal drives as centre-lines (px) with a width (px).
  roads: <{ pts: V2[]; width: number; kind: 'drive' | 'highway' }[]>[
    { kind: 'highway', width: 34, pts: poly([[600, 830], [700, 720], [800, 610]]) },
    { kind: 'drive', width: 13, pts: poly([[628, 790], [586, 726], [548, 684], [508, 664], [432, 634], [330, 604], [236, 566], [204, 500], [208, 420]]) },
    { kind: 'drive', width: 10, pts: poly([[208, 420], [300, 402], [440, 404], [530, 398], [560, 380]]) },
    { kind: 'drive', width: 9, pts: poly([[432, 634], [420, 700], [300, 712], [200, 712], [120, 700]]) },
    { kind: 'drive', width: 8, pts: poly([[204, 500], [178, 600], [176, 690]]) },
  ],

  gate: px(612, 770),

  buildings: <Building[]>[
    { id: 'reception', spaceId: 'RECEPTION', label: 'Reception', poly: rect(472, 582, 545, 650), height: 5.5, roof: 'hip', roofColor: 0xc8643b, wallColor: 0xf1ebe1 },
    { id: 'restaurant', spaceId: 'RESTAURANT', label: 'Sathya Dine', poly: rect(414, 556, 470, 594), height: 4.6, roof: 'hip', roofColor: 0xc8643b, wallColor: 0xf1ebe1 },
    { id: 'kitchen', spaceId: 'KITCHEN', label: 'Main Kitchen', poly: rect(384, 546, 416, 602), height: 4.2, roof: 'flat', roofColor: 0x5f7fa6, wallColor: 0xe6e4df },
    { id: 'pavilion', spaceId: 'PAVILION', label: 'Pavilion', poly: rect(266, 440, 364, 494), height: 5, roof: 'canopy', roofColor: 0xf3f1ec, wallColor: 0xd8d4cc },
    { id: 'hall', spaceId: 'HALL-JSH', label: 'A. John Samuel Hall', poly: rect(540, 296, 600, 366), height: 9, roof: 'hip', roofColor: 0xb4483a, wallColor: 0xf1ebe1 },
    { id: 'hall-annex', spaceId: 'HALL-JSH', label: 'A. John Samuel Hall', poly: rect(598, 282, 630, 362), height: 7, roof: 'flat', roofColor: 0xe9e6df, wallColor: 0xebe5da },
    { id: 'office', spaceId: 'OFFICE', label: 'Admin Office', poly: rect(550, 152, 626, 246), height: 8, roof: 'flat', roofColor: 0xd9d2c6, wallColor: 0xebe5da },
    { id: 'conv', spaceId: 'CONV-HALL', label: 'Convention Hall', poly: poly([[26, 506], [96, 518], [72, 730], [2, 716]]), height: 9, roof: 'hip', roofColor: 0xe4e6e8, wallColor: 0xd9dbdc },
    { id: 'service', spaceId: 'SERVICE', label: 'Service Block', poly: rect(200, 732, 402, 800), height: 6, roof: 'flat', roofColor: 0xa9aaa6, wallColor: 0xc9c7c0 },
    { id: 'shed', spaceId: 'SERVICE', label: 'Stores', poly: rect(90, 746, 160, 780), height: 4, roof: 'flat', roofColor: 0xb7b8b4, wallColor: 0xcfcdc6 },
    { id: 'poolhouse', spaceId: 'POOL', label: 'Pool House', poly: rect(754, 570, 782, 612), height: 3.8, roof: 'hip', roofColor: 0xb4483a, wallColor: 0xf1ebe1 },
  ],

  // Park Wing: 3 floors of 12 rooms ringed around a central courtyard
  // (4 north, 2 east, 4 south, 2 west, numbered clockwise from the NW corner).
  mainBlock: { rect: [426, 446, 526, 556] as const, floors: 3, floorHeight: 3.4, depth: 11 },

  villas: <{ id: string; poly: V2[] }[]>[
    { id: 'VILLA-1', poly: rect(124, 504, 166, 540) },
    { id: 'VILLA-2', poly: rect(120, 554, 160, 590) },
    { id: 'VILLA-3', poly: rect(124, 602, 166, 640) },
    { id: 'VILLA-4', poly: rect(138, 648, 174, 680) },
    { id: 'VILLA-5', poly: rect(184, 590, 216, 626) },
    { id: 'VILLA-6', poly: rect(180, 520, 214, 554) },
  ],
}

const ROOM_CATS: Record<number, { category: string; rate: number }> = {
  1: { category: 'Deluxe', rate: 4200 },
  2: { category: 'Deluxe', rate: 4500 },
  3: { category: 'Premium', rate: 5800 },
}

export function buildSpaces(): Space[] {
  const spaces: Space[] = []
  for (let f = 1; f <= SITE.mainBlock.floors; f++) {
    for (let r = 1; r <= 12; r++) {
      const no = `${f}${String(r).padStart(2, '0')}`
      spaces.push({
        id: `MAIN-${f}-${no}`, name: `Room ${no}`, type: 'room', hmsRoomNo: no, floor: f,
        category: ROOM_CATS[f].category, baseRate: ROOM_CATS[f].rate, capacity: 3,
      })
    }
  }
  SITE.villas.forEach((v, i) => spaces.push({
    id: v.id, name: `Garden Villa ${i + 1}`, type: 'villa', hmsRoomNo: `V${i + 1}`,
    category: 'Garden Villa', baseRate: 9500, capacity: 4, verify: true,
  }))
  spaces.push(
    { id: 'HALL-JSH', name: 'A. John Samuel Hall', type: 'hall', capacity: 600, baseRate: 150000 },
    { id: 'CONV-HALL', name: 'Convention Hall', type: 'hall', capacity: 1000, baseRate: 250000, verify: true },
    { id: 'LAWN-GRAND', name: 'Grand Lawn', type: 'lawn', capacity: 1200, baseRate: 200000 },
    { id: 'LAWN-GARDEN', name: 'Garden Lawn', type: 'lawn', capacity: 250, baseRate: 60000 },
    { id: 'PAVILION', name: 'Pavilion', type: 'pavilion', capacity: 150, baseRate: 40000, verify: true },
    { id: 'GROUND-CRICKET', name: 'Cricket Ground', type: 'ground', capacity: 400, baseRate: 25000, verify: true },
    { id: 'GROUND-NORTH', name: 'North Ground', type: 'ground', capacity: 2000, baseRate: 35000, verify: true },
    { id: 'RESTAURANT', name: 'Sathya Dine', type: 'restaurant', capacity: 80, verify: true },
    { id: 'KITCHEN', name: 'Main Kitchen', type: 'kitchen', verify: true },
    { id: 'RECEPTION', name: 'Reception & Lobby', type: 'reception' },
    { id: 'POOL', name: 'Pool & Deck', type: 'pool', capacity: 40 },
    { id: 'SERVICE', name: 'Service Block', type: 'service', verify: true },
    { id: 'OFFICE', name: 'Admin Office', type: 'office', verify: true },
  )
  return spaces
}

export const VENUE_IDS = ['HALL-JSH', 'CONV-HALL', 'LAWN-GRAND', 'LAWN-GARDEN', 'PAVILION', 'GROUND-CRICKET']
