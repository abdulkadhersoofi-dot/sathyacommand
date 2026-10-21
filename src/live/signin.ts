import qrcode from 'qrcode-generator'
import { ApiError, type Api } from './api'

// Sign-in screen: email and password → a new password if the one given was temporary → signed in.
// (The authenticator steps are used only if the server asks for them: sign_in.password_second_factor.)

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
  const os = /Android/.test(ua) ? 'Android' : /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'a computer'
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Browser'
  const kind = matchMedia('(pointer: coarse)').matches ? (Math.min(screen.width, screen.height) < 600 ? 'phone' : 'tablet') : 'computer'
  // The last characters of this browser's own ID tell two similar devices apart in the approval inbox.
  return `${br} on ${os} ${kind === 'computer' ? '' : kind} · ${deviceId().slice(-4).toUpperCase()}`.replace(/\s+/g, ' ')
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
    // Step 1: email and password
    let form = card(`<h1>Sign in</h1>
      <label for="si-email">Email</label><input id="si-email" type="email" inputmode="email" autocomplete="username" placeholder="name@example.com" required>
      <label for="si-password">Password</label><input id="si-password" type="password" autocomplete="current-password" required>
      <button class="btn primary" type="submit">Sign in</button>
      <p class="muted small">Forgot your password? Ask the MD or GM to reset it.</p>`)
    let password = ''
    let restart = false
    let res: { stage: string; token?: string; loginChallengeId?: string } | null = null
    for (;;) {
      await submitted(form)
      password = form.querySelector<HTMLInputElement>('#si-password')!.value
      try {
        res = await api.post('/auth/login', { email: form.querySelector<HTMLInputElement>('#si-email')!.value.trim(), password, deviceId: deviceId(), deviceLabel: deviceLabel() })
        break
      } catch (e) {
        if (e instanceof ApiError && e.body.stage === 'device_pending') {
          card(`<h1>Device waiting for approval</h1><p>${esc(e.message)}</p><p class="muted">Ask the MD or GM to approve "${esc(deviceLabel())}" under Approvals at the top of their screen, then sign in again.</p>
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

    // Step 4: a temporary password (new login, or reset by the MD or GM) is swapped for the person's own
    if (res.stage === 'set_password') {
      form = card(`<h1>Choose your password</h1><p class="muted">You signed in with a temporary password. Choose your own: at least 8 characters, and not your name or email.</p>
        <label for="si-new">New password</label><input id="si-new" type="password" autocomplete="new-password" minlength="8" required>
        <label for="si-new2">Type it again</label><input id="si-new2" type="password" autocomplete="new-password" minlength="8" required>
        <button class="btn primary" type="submit">Save and continue</button>`)
      for (;;) {
        await submitted(form)
        const next = form.querySelector<HTMLInputElement>('#si-new')!.value
        if (next !== form.querySelector<HTMLInputElement>('#si-new2')!.value) { fail(form, 'The two passwords are not the same.'); continue }
        try { await api.post('/auth/password', { current: password, next }); break }
        catch (e) { fail(form, (e as Error).message) }
      }
    }

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
