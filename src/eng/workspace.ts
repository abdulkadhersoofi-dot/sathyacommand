import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { Workspace, type View } from '../ui/workspace'
import { AssetsView, PlansView } from './assets'
import { reportFault } from './common'
import { ComplianceView, SparesView } from './stores'
import { TicketsView } from './tickets'
import { LogsView, MetersView } from './utilities'

// Engineering and maintenance: tickets (anyone reports, engineering fixes), planned maintenance,
// the asset register, meter readings, pool / STP / fire checks, spares, and the compliance calendar.

type Tab = 'tickets' | 'planned' | 'assets' | 'meters' | 'logs' | 'spares' | 'compliance'
interface Meta { categories: string[]; templates: Record<string, { title: string; everyDays: number; checklist: string[] }> }

export class EngWorkspace extends Workspace<Tab> {
  protected views: Record<Tab, View>
  private tickets: TicketsView
  private metaCache: Meta | null = null

  constructor(api: Api, me: Me, outbox: Outbox, onClose: () => void) {
    super(api, me, outbox, 'Engineering', onClose)
    this.tickets = new TicketsView(this)
    this.views = { tickets: this.tickets, planned: new PlansView(this), assets: new AssetsView(this), meters: new MetersView(this), logs: new LogsView(this), spares: new SparesView(this), compliance: new ComplianceView(this) }
    this.tab = 'tickets'
  }

  tabs(): [Tab, string][] {
    const t: [Tab, string][] = [['tickets', 'Tickets']]
    const eng = this.can('eng.work', 'eng.manage')
    if (eng) t.push(['planned', 'Planned'], ['assets', 'Assets'], ['meters', 'Meters'], ['logs', 'Safety checks'], ['spares', 'Spares'])
    if (this.can('compliance.view', 'licences.edit', 'eng.manage')) t.push(['compliance', 'Compliance'])
    return t
  }

  async meta() { return (this.metaCache ??= await this.api.get<Meta>('/api/eng/meta')) }

  /** Opens one ticket (from the inbox or the 3D map). */
  async openTicket(id: string) {
    await this.show('tickets')
    await this.tickets.open(id)
  }

  /** The fault form for a room (from the room panel), without opening the workspace. */
  report(spaceId: string, where: string) { reportFault(this, { spaceId, where }) }
}
