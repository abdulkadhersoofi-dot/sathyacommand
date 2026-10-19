import { describe, expect, it } from 'vitest'
import { blockCells, defaultLayout, layoutDiff, lodgingObjects, validateLayout } from '../src'

describe('site layout', () => {
  it('the traced default resort is valid, with 36 Park Wing rooms and 6 villas', () => {
    const l = defaultLayout()
    expect(validateLayout(l)).toEqual([])
    expect(blockCells(l.blocks[0])).toHaveLength(36)
    expect(blockCells(l.blocks[0]).slice(0, 2).map((c) => c.id)).toEqual(['MAIN-1-101', 'MAIN-1-102'])
    expect(lodgingObjects(l)).toHaveLength(42)
  })

  it('numbers a new block with its own prefix so room numbers never clash', () => {
    const l = defaultLayout()
    l.blocks.push({ id: 'lake-wing', label: 'Lake Wing', idPrefix: 'LAKE', numberPrefix: 'L', rect: [60, -80, 90, -50], floors: 2, floorHeight: 3.2, depth: 9, ring: [3, 1, 3, 1] })
    expect(validateLayout(l)).toEqual([])
    const cells = blockCells(l.blocks[1])
    expect(cells).toHaveLength(16)
    expect(cells[0]).toMatchObject({ id: 'LAKE-1-L101', roomNo: 'L101' })
  })

  it('explains what is wrong in plain words', () => {
    const l = defaultLayout()
    l.buildings[0].height = 90
    l.villas[1].id = l.villas[0].id
    l.blocks.push({ ...l.blocks[0], id: 'copy' })
    const problems = validateLayout(l)
    expect(problems).toContain('Building "Reception": height must be 2–40 m.')
    expect(problems.some((p) => p.startsWith('Two objects share the id'))).toBe(true)
  })

  it('catches two blocks that would produce the same room ids', () => {
    const l = defaultLayout()
    l.blocks.push({ ...l.blocks[0], id: 'copy', rect: [60, -80, 100, -40] })
    expect(validateLayout(l).some((p) => p.includes('Give one block a different code'))).toBe(true)
  })

  it('reports what changed between versions', () => {
    const a = defaultLayout(), b = defaultLayout()
    b.buildings = b.buildings.filter((x) => x.id !== 'shed')
    b.villas[0].poly = b.villas[0].poly.map(([x, z]) => [x + 5, z] as [number, number])
    b.villas.push({ id: 'VILLA-7', kind: 'cottage', poly: [[0, 0], [8, 0], [8, 8], [0, 8]] })
    expect(layoutDiff(a, b)).toEqual({ added: ['VILLA-7'], removed: ['shed'], changed: ['VILLA-1'] })
  })
})
