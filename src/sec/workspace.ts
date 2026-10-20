import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { Workspace, type View } from '../ui/workspace'
import { CamerasView, EmergencyView, IncidentsView, KeysView } from './desk'
import { GateView, PatrolsView } from './gate'

// Security: the gate register, patrols, incidents, keys, cameras and emergency mode. Anyone can report
// an incident and answer the roll-call; the rest is for security and managers.

type Tab = 'gate' | 'patrols' | 'incidents' | 'keys' | 'cameras' | 'emergency'

export class SecurityWorkspace extends Workspace<Tab> {
  protected views: Record<Tab, View>
  private incidents: IncidentsView
  private cameras: CamerasView

  constructor(api: Api, me: Me, outbox: Outbox, onClose: () => void) {
    super(api, me, outbox, 'Security', onClose)
    this.incidents = new IncidentsView(this)
    this.cameras = new CamerasView(this)
    this.views = { gate: new GateView(this), patrols: new PatrolsView(this), incidents: this.incidents, keys: new KeysView(this), cameras: this.cameras, emergency: new EmergencyView(this) }
    this.tab = this.tabs()[0][0]
  }

  tabs(): [Tab, string][] {
    const sec = this.can('security.gate', 'security.view')
    const t: [Tab, string][] = []
    if (sec) t.push(['gate', 'Gate'], ['patrols', 'Patrols'])
    t.push(['incidents', 'Incidents'])
    if (sec) t.push(['keys', 'Keys'], ['cameras', 'Cameras'])
    t.push(['emergency', 'Emergency'])
    return t
  }

  async openIncident(id: string) { await this.show('incidents'); this.incidents.open(id) }

  /** A camera pin on the 3D map opens that camera's live view. */
  async openCamera(id: string) { await this.cameras.load(); this.cameras.view(id) }
}
