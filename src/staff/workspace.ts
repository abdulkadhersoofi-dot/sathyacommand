import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { Workspace, type View } from '../ui/workspace'
import { t } from './i18n'
import { LoginsView } from './logins'
import { MyLeaveView } from './leave'
import { MyPayView } from './pay'
import { RostersView, StaffSettingsView } from './rosters'
import { MyAttendanceView, TeamView } from './team'
import { MessagesView, TodayView, type StaffHost } from './today'
import { Tracker } from './tracker'

// The staff app, the same on a phone and a desk: clock in and out, SOS, the person's work and messages,
// their own attendance; for managers the team on duty, rosters and the resort boundary.

type Tab = 'today' | 'messages' | 'mine' | 'leave' | 'pay' | 'team' | 'rosters' | 'settings' | 'logins'

export interface StaffLinks {
  /** Opens a piece of work from the inbox in its own workspace (a room to clean, food to pick up). */
  openWork(kind: string, ref: string): void
  /** Closes the workspace and shows the person (or everyone, for '') on the 3D map. */
  showOnMap(userId: string): void
}

export class StaffWorkspace extends Workspace<Tab> implements StaffHost {
  tracker: Tracker
  protected views: Record<Tab, View>

  constructor(api: Api, me: Me, outbox: Outbox, private links: StaffLinks, onClose: () => void) {
    super(api, me, outbox, 'Staff', onClose)
    this.tracker = new Tracker(api)
    this.views = { today: new TodayView(this), messages: new MessagesView(this), mine: new MyAttendanceView(this), leave: new MyLeaveView(this), pay: new MyPayView(this), team: new TeamView(this), rosters: new RostersView(this), settings: new StaffSettingsView(this), logins: new LoginsView(this) }
    this.tab = 'today'
  }

  tabs(): [Tab, string][] {
    const tabs: [Tab, string][] = [['today', t('Today')], ['messages', t('Messages')], ['mine', t('My attendance')], ['leave', t('My leave')], ['pay', t('My pay')]]
    if (this.can('staff.track', 'attendance.view')) tabs.push(['team', t('Team')])
    if (this.can('roster.manage')) tabs.push(['rosters', t('Rosters')])
    if (this.can('staff.settings')) tabs.push(['settings', t('Settings')])
    if (this.can('users.manage')) tabs.push(['logins', t('Logins')])
    return tabs
  }

  openWork(kind: string, ref: string) {
    if (kind === 'sos') { void this.show('team'); return }
    this.hide()
    this.links.openWork(kind, ref)
  }

  showOnMap(userId: string) {
    this.hide()
    this.links.showOnMap(userId)
  }

  /** Picks up an open shift after the app is reopened, so location keeps flowing. */
  async resume() {
    try {
      const me = await this.api.get<{ onDuty: boolean; consent: boolean }>('/api/staff/me')
      if (me.onDuty && me.consent) await this.tracker.start()
    } catch { /* offline: the Today screen retries */ }
  }
}
