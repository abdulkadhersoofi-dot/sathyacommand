import type { Api } from '../live/api'
import type { Me } from '../live/signin'
import type { Outbox } from '../live/outbox'
import { Workspace, type View } from '../ui/workspace'
import { BalanceSheetView, ChartView, DayBookView, JournalView, LedgerView, PeriodsView, PnlView, TrialBalanceView } from './books'

// Accounts: the books the resort's own records post into.

type Tab = 'daybook' | 'tb' | 'ledger' | 'pnl' | 'bs' | 'journal' | 'chart' | 'periods'
const fyStart = (day: string) => `${Number(day.slice(5, 7)) >= 4 ? day.slice(0, 4) : Number(day.slice(0, 4)) - 1}-04-01`

export class AccountsWorkspace extends Workspace<Tab> {
  protected views: Record<Tab, View>
  private ledger: LedgerView
  to = ''
  from = ''

  constructor(api: Api, me: Me, outbox: Outbox, onClose: () => void) {
    super(api, me, outbox, 'Accounts', onClose)
    this.ledger = new LedgerView(this)
    this.views = { daybook: new DayBookView(this), tb: new TrialBalanceView(this), ledger: this.ledger, pnl: new PnlView(this), bs: new BalanceSheetView(this), journal: new JournalView(this), chart: new ChartView(this), periods: new PeriodsView(this) }
    this.tab = 'tb'
  }

  /** The financial year to the business date, until the user picks other dates. */
  protected async beforeLoad() {
    if (this.to) return
    this.to = (await this.api.get<{ businessDate: string }>('/api/business-date')).businessDate
    this.from = fyStart(this.to)
  }

  static allowed(me: Me) { return ['*', 'accounts.view', 'accounts.post', 'accounts.lock'].some((p) => me.permissions.includes(p)) }

  tabs(): [Tab, string][] {
    return [['daybook', 'Day book'], ['tb', 'Trial balance'], ['ledger', 'Ledgers'], ['pnl', 'Profit & loss'], ['bs', 'Balance sheet'], ['journal', 'Journal'], ['chart', 'Chart of accounts'], ['periods', 'Locked months']]
  }

  openLedger(code: string, party = '') {
    this.ledger.code = code; this.ledger.party = party
    void this.show('ledger')
  }
}
