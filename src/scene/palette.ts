import * as THREE from 'three'
import type { RoomStatus } from '../data/store'
import type { HkStatus } from '../data/types'

// Semantic colours shared by the 3D scene and the HTML panels (see --st-* in style.css).
export const STATUS_HEX: Record<RoomStatus, number> = {
  vacant: 0x35a46b, dirty: 0x9b6bd3, arriving: 0xe8a317, occupied: 0x3b7be0, departing: 0xe0533d, ooo: 0x80878d,
}
export const HK_HEX: Record<HkStatus, number> = {
  clean: 0x35a46b, inspected: 0x1f9aa0, dirty: 0x9b6bd3, 'out-of-order': 0x80878d,
}
export const STATUS_LABEL: Record<RoomStatus, string> = {
  vacant: 'Vacant', dirty: 'Needs cleaning', arriving: 'Arriving', occupied: 'In-house', departing: 'Departing', ooo: 'Out of order',
}
const REV_LO = new THREE.Color(0xf4e7c2), REV_HI = new THREE.Color(0xb3541e)
export const revenueColor = (k: number, out = new THREE.Color()) => out.copy(REV_LO).lerp(REV_HI, Math.max(0, Math.min(1, k)))
export const FACADE = new THREE.Color(0xf2ece2)
