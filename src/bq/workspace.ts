import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { Workspace, type View, type WorkspaceHost } from '../ui/workspace'
import { CalendarView } from './calendar'
import { EventsView } from './events'
import { BeoView } from './beo'
import { VenuesView } from './venues'

// Banquets: the venue calendar, events from enquiry to the final bill, the event orders each department
// works from, and the venues and packages that are sold.

type Tab = 'calendar' | 'events' | 'beo' | 'venues'
export type BqHost = WorkspaceHost & { openEvent(id: string): void; newEnquiry(venueId?: string, date?: string): void }

export class BanquetsWorkspace extends Workspace<Tab> implements BqHost {
  protected views: Record<Tab, View>
  private events: EventsView

  constructor(api: Api, me: Me, outbox: Outbox, onClose: () => void) {
    super(api, me, outbox, 'Banquets', onClose)
    this.events = new EventsView(this)
    this.views = { calendar: new CalendarView(this), events: this.events, beo: new BeoView(this), venues: new VenuesView(this) }
    this.tab = this.tabs()[0][0]
  }

  static allowed(me: Me) { return ['*', 'events.view', 'events.manage', 'events.payment', 'events.bill', 'venues.manage', 'beo.view'].some((p) => me.permissions.includes(p)) }

  tabs(): [Tab, string][] {
    const t: [Tab, string][] = []
    const events = this.can('events.view', 'events.manage', 'events.payment', 'events.bill', 'venues.manage')
    if (events) t.push(['calendar', 'Venue calendar'], ['events', 'Events'])
    if (this.can('beo.view', 'events.manage', 'events.view')) t.push(['beo', 'Event orders'])
    if (!events && this.can('beo.view')) t.unshift(['calendar', 'Venue calendar'])
    if (this.can('venues.manage', 'events.manage')) t.push(['venues', 'Venues & packages'])
    return t
  }

  openEvent(id: string) { this.events.selected = id; void this.show('events') }
  newEnquiry(venueId?: string, date?: string) {
    this.events.selected = null
    void this.show('events')
    void this.events.enquiry(venueId, date)
  }
}
