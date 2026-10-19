import qrcode from 'qrcode-generator'
import { ApiError, type Api } from './api'

// Sign-in screen: mobile number → SMS code → authenticator code (or first-time set-up) → signed in.

export interface Me { id: string; name: string; roles: string[]; godMode: boolean; permissions: string[]; scope: string }

const DEVICE_KEY = 'sathya.deviceId'
function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) { id = 'dev-' + crypto.randomUUID().slice(0, 12); localStorage.setItem(DEVICE_KEY, id) }
    return id
  } catch { return 'dev-session-' + Math.random().toString(36).slice(2, 10) }
}
const deviceLabel = () => {
  const ua = navigator.userAgent
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Device'
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Browser'
  return `${br} on ${os}`
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export async function signIn(api: Api): Promise<Me> {
  if (api.token) {
    try {
      const me = await api.get<Me>('/auth/me')
      if (me.scope === 'full') return me
    } catch { api.setToken(null) }
  }

  const root = document.createElement('div')
  root.className = 'signin'
  document.body.appendChild(root)
  const card = (inner: string) => {
    root.innerHTML = `<form class="signin-card" novalidate>
      <div class="signin-brand"><span class="brand-mark" aria-hidden="true"></span><div><div class="brand-name">Sathya Command</div><div class="brand-sub">Sathya Park &amp; Resorts</div></div></div>
      ${inner}<div class="signin-error" hidden></div></form>`
    const form = root.querySelector('form')!
    const input = form.querySelector<HTMLInputElement>('input')
    input?.focus()
    return form
  }
  const fail = (form: HTMLFormElement, msg: string) => {
    const el = form.querySelector<HTMLElement>('.signin-error')!
    el.textContent = msg
    el.hidden = false
    form.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = false
  }
  const submitted = (form: HTMLFormElement) => new Promise<void>((resolve) => form.addEventListener('submit', (e) => {
    e.preventDefault()
    form.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = true
    form.querySelector<HTMLElement>('.signin-error')!.hidden = true
    resolve()
  }, { once: true }))

  let token = ''
  for (;;) {
    // Step 1: mobile number
    let form = card(`<h1>Sign in</h1><label for="si-mobile">Mobile number</label>
      <input id="si-mobile" inputmode="tel" autocomplete="tel" placeholder="98400 00000" required>
      <button class="btn primary" type="submit">Send code</button>`)
    let challengeId = ''
    let mobile = ''
    for (;;) {
      await submitted(form)
      mobile = form.querySelector<HTMLInputElement>('#si-mobile')!.value
      try { challengeId = (await api.post<{ challengeId: string }>('/auth/otp', { mobile })).challengeId; break }
      catch (e) { fail(form, (e as Error).message) }
    }

    // Step 2: SMS code
    form = card(`<h1>Enter the code</h1><p class="muted">We sent a 6-digit code to ${esc(mobile)}.</p>
      <label for="si-code">Code</label><input id="si-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
      <button class="btn primary" type="submit">Continue</button><button class="btn ghost" type="button" data-restart>Use a different number</button>`)
    let restart = false
    form.querySelector('[data-restart]')!.addEventListener('click', () => { restart = true; form.requestSubmit() })
    let res: { stage: string; token?: string; loginChallengeId?: string } | null = null
    for (;;) {
      await submitted(form)
      if (restart) break
      try {
        res = await api.post('/auth/otp/verify', { challengeId, code: form.querySelector<HTMLInputElement>('#si-code')!.value.trim(), deviceId: deviceId(), deviceLabel: deviceLabel() })
        break
      } catch (e) {
        if (e instanceof ApiError && e.body.stage === 'device_pending') {
          card(`<h1>Device waiting for approval</h1><p>${esc(e.message)}</p><p class="muted">Ask the MD or GM to approve "${esc(deviceLabel())}" in the approval inbox, then sign in again.</p>
            <button class="btn primary" type="submit">Sign in again</button>`)
          await submitted(root.querySelector('form')!)
          restart = true
          break
        }
        fail(form, (e as Error).message)
      }
    }
    if (restart || !res) continue

    // Step 3a: authenticator code
    if (res.stage === 'second_factor') {
      form = card(`<h1>Authenticator code</h1><p class="muted">Open your authenticator app and enter the 6-digit code for Sathya HMS.</p>
        <label for="si-totp">Code</label><input id="si-totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
        <button class="btn primary" type="submit">Sign in</button>`)
      for (;;) {
        await submitted(form)
        try {
          const done = await api.post<{ token: string }>('/auth/second-factor', { loginChallengeId: res.loginChallengeId, code: form.querySelector<HTMLInputElement>('#si-totp')!.value.trim() })
          token = done.token
          break
        } catch (e) { fail(form, (e as Error).message) }
      }
    } else token = res.token!
    api.setToken(token)

    // Step 3b: first sign-in for owner and finance roles sets up the authenticator app
    if (res.stage === 'enroll_2fa') {
      const { secret, otpauthUrl } = await api.post<{ secret: string; otpauthUrl: string }>('/auth/totp/enroll')
      const qr = qrcode(0, 'M')
      qr.addData(otpauthUrl)
      qr.make()
      form = card(`<h1>Set up your authenticator</h1>
        <p class="muted">Your role needs a second code at every sign-in. Scan this with Google Authenticator or Microsoft Authenticator, then enter the code it shows.</p>
        <div class="signin-qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>
        <p class="muted">Can't scan? Enter this key: <code>${esc(secret.replace(/(.{4})/g, '$1 ').trim())}</code></p>
        <label for="si-enrol">Code from the app</label><input id="si-enrol" inputmode="numeric" maxlength="6" required>
        <button class="btn primary" type="submit">Finish set-up</button>`)
      for (;;) {
        await submitted(form)
        try { await api.post('/auth/totp/confirm', { code: form.querySelector<HTMLInputElement>('#si-enrol')!.value.trim() }); break }
        catch (e) { fail(form, (e as Error).message) }
      }
    }
    break
  }
  root.remove()
  return api.get<Me>('/auth/me')
}
