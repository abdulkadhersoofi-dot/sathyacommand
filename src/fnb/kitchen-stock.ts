import { esc, tonePill } from '../ui/dom'
import { val } from '../ui/form-modal'
import { chips, rs, type Ws } from './common'

// Kitchen stock: ingredients and what is on the shelf, recipes per dish with their cost, receipts,
// wastage and counts, and the food cost report with menu engineering.

interface Ingredient { id: string; name: string; unit: 'g' | 'ml' | 'pcs'; stock: number; parLevel: number | null; costPerPack: number; pack: string; valuePaise: number; belowPar: boolean; placeholder: boolean; active: boolean }
interface Recipe { code: string; name: string; price_paise: number; outlets: string[]; lines: { ingredientId: string; name: string; unit: string; qty: number; costPaise: number }[]; costPaise: number; costPercent: number | null }
interface FoodCost { from: string; to: string; dishes: { code: string; name: string; qty: number; salesPaise: number; costPaise: number; costPercent: number; hasRecipe: boolean; class?: string }[]
  totals: { salesPaise: number; theoreticalCostPaise: number; theoreticalPercent: number; wastagePaise: number; countLossPaise: number; actualCostPaise: number; actualPercent: number; dishesWithoutRecipe: string[] } }
type Sub = 'stock' | 'recipes' | 'cost'

const CLASS: Record<string, [string, string, string]> = {
  star: ['Star', '--st-vacant', 'Popular and profitable: keep and feature'], plowhorse: ['Plowhorse', '--st-occupied', 'Popular, low margin: review price or portion'],
  puzzle: ['Puzzle', '--marigold', 'Profitable, slow seller: promote it'], dog: ['Dog', '--st-departing', 'Slow and low margin: rework or drop'],
}
const big = (u: string) => (u === 'pcs' ? 1 : 1000)
const qtyText = (q: number, u: string) => (u === 'pcs' ? `${q} pcs` : Math.abs(q) >= 1000 ? `${Math.round(q / 10) / 100} ${u === 'g' ? 'kg' : 'L'}` : `${q} ${u}`)

export class KitchenStockView {
  sub: Sub = 'stock'
  from = ''
  to = ''
  private ingredients: Ingredient[] = []
  private recipes: Recipe[] = []
  private cost: FoodCost | null = null

  constructor(private ws: Ws) {}

  private get edit() { return this.ws.can('kitchen.stock') }

  async load() {
    const api = this.ws.api
    this.ingredients = await api.get('/api/kitchen/ingredients')
    if (this.sub === 'recipes') this.recipes = await api.get('/api/kitchen/recipes')
    if (this.sub === 'cost') {
      this.cost = await api.get(`/api/kitchen/food-cost${this.from ? `?from=${this.from}&to=${this.to || this.from}` : ''}`)
      this.from = this.cost!.from; this.to = this.cost!.to
    }
  }

  html() {
    const subs: [Sub, string][] = [['stock', 'Ingredients'], ['recipes', 'Recipes'], ...(this.ws.can('food_cost.view') ? [['cost', 'Food cost'] as [Sub, string]] : [])]
    const actions = this.edit ? '<button type="button" class="btn" data-k="receive">Receive stock</button><button type="button" class="btn" data-k="count">Count</button>' : ''
    const bar = `<div class="ws-toolbar">${chips(subs, this.sub, 'ksub')}${actions}<button type="button" class="btn" data-k="waste">Record wastage</button></div>`
    if (this.sub === 'stock') {
      const low = this.ingredients.filter((i) => i.active && (i.belowPar || i.stock < 0)).length
      return bar + (this.edit ? '<div class="ws-toolbar"><button type="button" class="btn primary" data-k="add-ing">Add ingredient</button></div>' : '')
        + (low ? `<p class="fd-warn small">${low} ingredient${low > 1 ? 's are' : ' is'} below the reorder level or below zero.</p>` : '')
        + `<div class="m-table">${this.ingredients.map((i) => `<div class="m-row m-row-4${i.active ? '' : ' retired'}${i.stock < 0 ? ' warn' : ''}"><b>${esc(i.name)}</b>
          <span class="mono">${qtyText(i.stock, i.unit)}${i.parLevel != null ? `<small class="muted"> · reorder at ${qtyText(i.parLevel, i.unit)}</small>` : ''}</span>
          <span class="muted small">₹${i.costPerPack} / ${i.pack}${i.valuePaise ? ` · ${rs(i.valuePaise)}` : ''}${i.placeholder ? ' · sample' : ''}</span>
          <span>${i.stock < 0 ? tonePill('Below zero', '--st-departing') : i.belowPar ? tonePill('Reorder', '--marigold') : ''}${this.edit ? ` <button type="button" class="btn small" data-edit-ing="${esc(i.id)}">Edit</button>` : ''}</span></div>`).join('')}</div>`
    }
    if (this.sub === 'recipes') {
      return bar + `<p class="muted small">One recipe per dish code, shared by every outlet that sells it. Quantities are per portion.</p>
        <div class="m-table">${this.recipes.map((r) => `<div class="m-row m-row-4"><span class="mono">${esc(r.code)}</span><b>${esc(r.name)}</b>
          <span class="small">${r.lines.length ? `${r.lines.length} ingredients · cost ${rs(r.costPaise)} · <b class="${(r.costPercent ?? 0) > 35 ? 'fd-warn' : ''}">${r.costPercent}%</b> of ${rs(r.price_paise)}` : '<span class="fd-warn">No recipe yet</span>'}</span>
          ${this.edit ? `<button type="button" class="btn small" data-recipe="${esc(r.code)}">${r.lines.length ? 'Edit' : 'Add'}</button>` : '<span></span>'}</div>`).join('')}</div>`
    }
    const c = this.cost!
    const t = c.totals
    return bar + `<div class="ws-toolbar"><label class="inline">From <input type="date" name="kfrom" value="${esc(c.from)}"></label><label class="inline">To <input type="date" name="kto" value="${esc(c.to)}"></label></div>
      <div class="kpi-strip">
        <div><span>Food sales</span><b>${rs(t.salesPaise)}</b></div>
        <div><span>Recipe cost</span><b>${rs(t.theoreticalCostPaise)} · ${t.theoreticalPercent}%</b></div>
        <div><span>Wastage</span><b>${rs(t.wastagePaise)}</b></div>
        <div><span>Count shortfall</span><b>${rs(t.countLossPaise)}</b></div>
        <div><span>Actual food cost</span><b class="${t.actualPercent > 35 ? 'fd-warn' : ''}">${rs(t.actualCostPaise)} · ${t.actualPercent}%</b></div>
      </div>
      ${t.dishesWithoutRecipe.length ? `<p class="fd-warn small">No recipe for ${t.dishesWithoutRecipe.map(esc).join(', ')}: their cost is missing from the figures.</p>` : ''}
      <div class="m-table">${c.dishes.map((d) => `<div class="m-row m-row-fc"><span class="mono">${esc(d.code)}</span><b>${esc(d.name)}</b><span class="mono">${d.qty} sold</span>
        <span class="mono">${rs(d.salesPaise)}</span><span class="mono">${d.hasRecipe ? `${rs(d.costPaise)} · ${d.costPercent}%` : '—'}</span>
        <span title="${esc(d.class ? CLASS[d.class][2] : '')}">${d.class ? tonePill(CLASS[d.class][0], CLASS[d.class][1]) : ''}</span></div>`).join('') || '<div class="empty">No food sold in these dates.</div>'}</div>
      <p class="muted small">Star: popular and profitable · Plowhorse: popular, low margin · Puzzle: profitable but slow · Dog: slow and low margin.</p>`
  }

  private ingOptions(selected?: string) {
    return this.ingredients.filter((i) => i.active).map((i) => `<option value="${esc(i.id)}" data-unit="${i.unit}" ${i.id === selected ? 'selected' : ''}>${esc(i.name)} (${i.unit})</option>`).join('')
  }

  async click(t: HTMLElement): Promise<boolean> {
    const api = this.ws.api, modal = this.ws.modal
    const sub = t.closest<HTMLElement>('[data-ksub]')?.dataset.ksub as Sub | undefined
    if (sub) { this.sub = sub; await this.load(); return true }
    const done = async (msg: string) => { await this.load(); this.ws.render(); return msg }
    const ei = t.closest<HTMLElement>('[data-edit-ing]')?.dataset.editIng
    if (ei) {
      const i = this.ingredients.find((x) => x.id === ei)!
      modal.open(i.name, `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="60" value="${esc(i.name)}"></label>
        <label>₹ per ${i.pack}<input name="cost" type="number" min="0" step="0.01" value="${i.costPerPack}"></label><label>Reorder at (${i.unit})<input name="par" type="number" min="0" value="${i.parLevel ?? ''}"></label>
        <label class="check"><input type="checkbox" name="active" ${i.active ? 'checked' : ''}> In use</label></div>`, 'Save', async (f) => {
        await api.req('PATCH', `/api/kitchen/ingredients/${ei}`, { name: val(f, 'name'), costPerPack: Number(val(f, 'cost')), parLevel: val(f, 'par') === '' ? null : Number(val(f, 'par')), active: (f.elements.namedItem('active') as HTMLInputElement).checked })
        return done('Saved')
      })
      return true
    }
    const rc = t.closest<HTMLElement>('[data-recipe]')?.dataset.recipe
    if (rc) {
      const r = this.recipes.find((x) => x.code === rc)!
      const row = (n: number, l?: Recipe['lines'][number]) => `<div class="pay-row recipe-row" data-rl="${n}" ${l || n === 0 ? '' : 'hidden'}><select name="i${n}"><option value="">—</option>${this.ingOptions(l?.ingredientId)}</select>
        <input name="q${n}" type="number" min="0" step="0.5" value="${l?.qty ?? ''}" placeholder="Qty per portion" aria-label="Quantity per portion"></div>`
      modal.open(`Recipe · ${r.name}`, `<p class="muted small">Per portion, in each ingredient's unit (g, ml or pieces). Price ${rs(r.price_paise)}.</p>
        ${Array.from({ length: 20 }, (_, n) => row(n, r.lines[n])).join('')}<button type="button" class="btn small ghost" data-morerl>Another ingredient</button>`, 'Save recipe', async (f) => {
        const lines = Array.from({ length: 20 }, (_, n) => ({ ingredientId: val(f, `i${n}`), qty: Number(val(f, `q${n}`) || 0) })).filter((l) => l.ingredientId && l.qty > 0)
        await api.req('PUT', `/api/kitchen/recipes/${rc}`, { lines })
        return done('Recipe saved')
      })
      modal.el.querySelector('[data-morerl]')!.addEventListener('click', () => { const h = modal.el.querySelector<HTMLElement>('[data-rl][hidden]'); if (h) h.hidden = false })
      return true
    }
    const act = t.closest<HTMLElement>('[data-k]')?.dataset.k
    if (!act) return false
    if (act === 'add-ing') {
      modal.open('Add ingredient', `<div class="form-grid"><label class="span2">Name<input name="name" maxlength="60"></label>
        <label>Counted in<select name="unit"><option value="g">grams (price per kg)</option><option value="ml">ml (price per litre)</option><option value="pcs">pieces</option></select></label>
        <label>Price ₹<input name="cost" type="number" min="0" step="0.01"></label><label>Reorder at<input name="par" type="number" min="0" placeholder="in g / ml / pcs"></label></div>`, 'Add', async (f) => {
        await api.post('/api/kitchen/ingredients', { name: val(f, 'name'), unit: val(f, 'unit'), costPerPack: Number(val(f, 'cost') || 0), parLevel: val(f, 'par') === '' ? null : Number(val(f, 'par')) })
        return done('Ingredient added')
      })
    }
    if (act === 'receive') {
      const row = (n: number) => `<div class="pay-row" data-rr="${n}" ${n ? 'hidden' : ''}><select name="i${n}"><option value="">—</option>${this.ingOptions()}</select>
        <input name="q${n}" type="number" min="0" step="0.01" placeholder="Qty (kg / L / pcs)" aria-label="Quantity"><input name="c${n}" type="number" min="0" step="0.01" placeholder="₹ total" aria-label="Cost"></div>`
      modal.open('Receive into the kitchen', `${Array.from({ length: 15 }, (_, n) => row(n)).join('')}<button type="button" class="btn small ghost" data-morerr>Another item</button>
        <div class="form-grid"><label class="span2">Note<input name="note" maxlength="120" placeholder="e.g. issue from stores, supplier bill no."></label></div>`, 'Receive', async (f) => {
        const lines = Array.from({ length: 15 }, (_, n) => {
          const id = val(f, `i${n}`), unit = this.ingredients.find((i) => i.id === id)?.unit ?? 'g'
          return { ingredientId: id, qty: Number(val(f, `q${n}`) || 0) * big(unit), cost: Number(val(f, `c${n}`) || 0) }
        }).filter((l) => l.ingredientId && l.qty > 0)
        await api.post('/api/kitchen/receipts', { lines, note: val(f, 'note') || undefined })
        return done('Stock received')
      })
      modal.el.querySelector('[data-morerr]')!.addEventListener('click', () => { const h = modal.el.querySelector<HTMLElement>('[data-rr][hidden]'); if (h) h.hidden = false })
    }
    if (act === 'waste') {
      modal.open('Record wastage', `<div class="form-grid"><label class="span2">Ingredient<select name="ing">${this.ingOptions()}</select></label>
        <label>Quantity (g / ml / pcs)<input name="qty" type="number" min="0" step="1"></label><label>Reason<input name="reason" maxlength="120" placeholder="spoiled, burnt, dropped"></label></div>`, 'Record', async (f) => {
        const r = await api.post<{ pending?: boolean }>('/api/kitchen/wastage', { ingredientId: val(f, 'ing'), qty: Number(val(f, 'qty')), reason: val(f, 'reason') })
        return done(r.pending ? 'Above your limit: sent to the F&B manager' : 'Wastage recorded')
      })
    }
    if (act === 'count') {
      modal.open('Kitchen count', `<p class="muted small">Enter what is on the shelf. Leave blank to skip.</p><div class="count-grid">${this.ingredients.filter((i) => i.active).map((i) => `<label><span>${esc(i.name)} <small class="muted">book ${qtyText(i.stock, i.unit)}</small></span>
        <input name="c_${esc(i.id)}" type="number" min="0" step="0.01" placeholder="${i.unit === 'pcs' ? 'pcs' : i.unit === 'g' ? 'kg' : 'litres'}" aria-label="Counted"></label>`).join('')}</div>`, 'Save count', async (f) => {
        const lines = this.ingredients.filter((i) => val(f, `c_${i.id}`) !== '').map((i) => ({ ingredientId: i.id, qty: Number(val(f, `c_${i.id}`)) * big(i.unit) }))
        const r = await api.post<{ shortfallPaise: number }>('/api/kitchen/counts', { lines })
        return done(r.shortfallPaise ? `Count saved. Shortfall ${rs(r.shortfallPaise)} logged.` : 'Count saved')
      })
    }
    return true
  }

  async change(t: HTMLElement): Promise<boolean> {
    const n = (t as HTMLInputElement).name
    if (n !== 'kfrom' && n !== 'kto') return false
    if (n === 'kfrom') this.from = (t as HTMLInputElement).value
    else this.to = (t as HTMLInputElement).value
    if (this.to < this.from) this.to = this.from
    await this.load()
    return true
  }
}
