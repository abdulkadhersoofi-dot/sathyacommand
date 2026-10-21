import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { Workspace, type View, type WorkspaceHost } from '../ui/workspace'
import { CalendarView } from './calendar'
import { EventsView } from './events'
import { BeoView } from './beo'
import { VenuesView } from './venues'
import { SalesView } from './sales'
import { AccountsView } from './accounts'
import { BlocksView } from './blocks'
import { ChannelsView } from './channels'

// Banquets & sales: the venue calendar, events from enquiry to the final bill, the sales pipeline and
// follow-ups, company accounts, room blocks, the event orders each department works from, and the venues
// and packages that are sold.

type Tab = 'calendar' | 'events' | 'sales' | 'accounts' | 'blocks' | 'channels' | 'beo' | 'venues'
export type BqHost = WorkspaceHost & { openEvent(id: string): void; newEnquiry(venueId?: string, date?: string): void; newBlock(eventId: string, title: string): void; openBlock(id: string): void }

export class BanquetsWorkspace extends Workspace<Tab> implements BqHost {
  protected views: Record<Tab, View>
  private events: EventsView
  private blocks: BlocksView

  constructor(api: Api, me: Me, outbox: Outbox, onClose: () => void) {
    super(api, me, outbox, 'Banquets & sales', onClose)
    this.events = new EventsView(this)
    this.blocks = new BlocksView(this)
    this.views = { calendar: new CalendarView(this), events: this.events, sales: new SalesView(this), accounts: new AccountsView(this), blocks: this.blocks, channels: new ChannelsView(this), beo: new BeoView(this), venues: new VenuesView(this) }
    this.tab = this.tabs()[0][0]
  }

  static allowed(me: Me) { return ['*', 'events.view', 'events.manage', 'events.payment', 'events.bill', 'venues.manage', 'beo.view', 'sales.manage', 'rates.contract', 'revenue.manage', 'front_desk'].some((p) => me.permissions.includes(p)) }

  tabs(): [Tab, string][] {
    const t: [Tab, string][] = []
    const events = this.can('events.view', 'events.manage', 'events.payment', 'events.bill', 'venues.manage')
    if (events) t.push(['calendar', 'Venue calendar'], ['events', 'Events'])
    const sales = this.can('sales.manage', 'rates.contract', 'events.manage', 'events.view')
    if (sales) t.push(['sales', 'Sales'])
    if (this.can('sales.manage', 'rates.contract')) t.push(['accounts', 'Accounts'])
    if (sales) t.push(['blocks', 'Room blocks'])
    if (this.can('revenue.manage', 'front_desk')) t.push(['channels', 'Rates & channels'])
    if (this.can('beo.view', 'events.manage', 'events.view')) t.push(['beo', 'Event orders'])
    if (!events && this.can('beo.view')) t.unshift(['calendar', 'Venue calendar'])
    if (this.can('venues.manage', 'events.manage')) t.push(['venues', 'Venues & packages'])
    return t
  }

  openEvent(id: string) { this.events.selected = id; void this.show('events') }
  newBlock(eventId: string, title: string) { this.blocks.selected = null; void this.show('blocks'); void this.blocks.create(eventId, title) }
  openBlock(id: string) { this.blocks.selected = id; void this.show('blocks') }
  newEnquiry(venueId?: string, date?: string) {
    this.events.selected = null
    void this.show('events')
    void this.events.enquiry(venueId, date)
  }
}
