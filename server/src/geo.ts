import { blockCells, type SiteLayout, type V2 } from '@sathya/twin'
import type { Db } from './db'

// Where things are: distance on the ground, phone GPS onto the 3D model's metres (x east, z south),
// and the centre of a building or room on the published layout.

export interface GeoSettings { lat: number | null; lng: number | null; radiusM: number; mapX: number; mapZ: number; rotation: number; selfieRequired: boolean }

export async function geoSettings(db: Db): Promise<GeoSettings> {
  const [p] = await db.query<{ geo_lat: string | null; geo_lng: string | null; geo_radius_m: number; geo_map_x: string; geo_map_z: string; geo_rotation: string; selfie_required: boolean }>(
    'select geo_lat, geo_lng, geo_radius_m, geo_map_x, geo_map_z, geo_rotation, selfie_required from property limit 1')
  return {
    lat: p.geo_lat == null ? null : Number(p.geo_lat), lng: p.geo_lng == null ? null : Number(p.geo_lng), radiusM: p.geo_radius_m,
    mapX: Number(p.geo_map_x), mapZ: Number(p.geo_map_z), rotation: Number(p.geo_rotation), selfieRequired: p.selfie_required,
  }
}

/** Metres between two GPS points. */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000, toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** A GPS point in the model's metres: offset from the centre, turned by the map's rotation. */
export function toMap(g: GeoSettings, lat: number, lng: number): { x: number; z: number } | null {
  if (g.lat == null || g.lng == null) return null
  const east = (lng - g.lng) * 111320 * Math.cos((g.lat * Math.PI) / 180)
  const south = -(lat - g.lat) * 110574
  const r = (g.rotation * Math.PI) / 180
  return { x: Math.round((g.mapX + east * Math.cos(r) - south * Math.sin(r)) * 100) / 100, z: Math.round((g.mapZ + east * Math.sin(r) + south * Math.cos(r)) * 100) / 100 }
}

const centroid = (p: V2[]): V2 => [p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length]

/** Centre of a space on the published 3D layout (by its twin id), if it is drawn. */
export async function spacePosition(db: Db, spaceId: string): Promise<{ x: number; z: number } | null> {
  const [s] = await db.query<{ twin_id: string | null }>('select twin_id from space where id = $1', [spaceId])
  const twin = s?.twin_id ?? spaceId
  const [v] = await db.query<{ layout: SiteLayout }>(`select layout from site_version where status = 'published'`)
  if (!v) return null
  const l = v.layout
  const b = l.buildings.find((x) => x.id === twin || x.spaceId === spaceId || x.spaceId === twin)
  if (b) { const [x, z] = centroid(b.poly); return { x, z } }
  const vil = l.villas.find((x) => x.id === twin)
  if (vil) { const [x, z] = centroid(vil.poly); return { x, z } }
  for (const blk of l.blocks) {
    const cell = blockCells(blk).find((c) => c.id === twin)
    if (cell) return { x: cell.x, z: cell.z }
  }
  for (const g of [...l.ground, ...l.pools]) if (g.id === twin || g.spaceId === spaceId) { const [x, z] = centroid(g.poly); return { x, z } }
  return null
}

/** Work done at a known place (a room cleaning started, a QR round) also places the person on the map, if they are on duty. */
export async function placeAt(t: Db, userId: string, spaceId: string, now: Date) {
  const [a] = await t.query('select 1 from attendance where user_id = $1 and clock_out_at is null', [userId])
  if (!a) return
  const pos = await spacePosition(t, spaceId)
  const [s] = await t.query<{ name: string }>('select name from space where id = $1', [spaceId])
  await t.query(`insert into location_ping (user_id, at, source, x, z, inside, place) values ($1,$2,'qr',$3,$4,true,$5)`, [userId, now, pos?.x ?? null, pos?.z ?? null, s?.name ?? null])
}
