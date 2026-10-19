import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { Workspace, type View } from '../ui/workspace'
import { AreasView } from './areas'
import { BoardView } from './board'
import { roomActions, type HkHost, type Room } from './common'
import { LaundryView } from './laundry'
import { LinenView } from './linen'
import { LostView } from './lost'
import { MineView } from './mine'
import { TasksView } from './tasks'

// The housekeeping workspace: the room board, the attendant's own rooms, assignment and inspection,
// public-area rounds, guest laundry and price lists, linen, and lost & found.

type Tab = 'mine' | 'board' | 'tasks' | 'areas' | 'laundry' | 'linen' | 'lost'

export class HkWorkspace extends Workspace<Tab> implements HkHost {
  rooms: Room[] = []
  protected views: Record<Tab, View>

  constructor(api: Api, me: Me, outbox: Outbox, onClose: () => void) {
    super(api, me, outbox, 'Housekeeping', onClose)
    this.views = { mine: new MineView(this), board: new BoardView(this), tasks: new TasksView(this), areas: new AreasView(this), laundry: new LaundryView(this), linen: new LinenView(this), lost: new LostView(this) }
    this.tab = this.tabs()[0]?.[0] ?? 'board'
  }

  static allowed(me: Me) {
    const p = me.permissions
    return p.includes('*') || ['hk.view', 'hk.attend', 'hk.inspect', 'hk.manage', 'front_desk'].some((x) => p.includes(x))
  }

  tabs(): [Tab, string][] {
    const t: [Tab, string][] = []
    const attendantOnly = this.can('hk.attend') && !this.can('hk.manage', 'hk.inspect')
    if (this.can('hk.attend') && !this.me.permissions.includes('*')) t.push(['mine', 'My rooms'])
    t.push(['board', 'Rooms'])
    if (this.can('hk.manage', 'hk.inspect')) t.push(['tasks', 'Assign & inspect'])
    if (this.can('hk.attend', 'hk.manage')) t.push(['areas', 'Public areas'])
    t.push(['laundry', attendantOnly ? 'Laundry' : 'Laundry & minibar'])
    if (this.can('hk.manage', 'hk.inspect')) t.push(['linen', 'Linen'])
    t.push(['lost', 'Lost & found'])
    return t
  }

  async loadRooms() { this.rooms = (await this.cached<{ rooms: Room[] }>('/api/hk/rooms')).rooms }

  /** Opens a room's actions (from the 3D map). */
  async openRoom(spaceId: string) {
    await this.show('board')
    const r = this.rooms.find((x) => x.space_id === spaceId)
    if (r) await roomActions(this, r)
  }
}
