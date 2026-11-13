// Mirg on the web: describe a game, and an AI agent writes it, runs it and fixes it right here in
// the browser. The agent loop runs on this page and calls the model through Mirg's API, which
// meters usage against the account's plan exactly as it does for the desktop app. Games are kept
// in this browser (IndexedDB) and run in a sandboxed frame that cannot see this page or its sign-in.

const SUPABASE = 'https://dlnmbeqdtpyjkprkxfvt.supabase.co'
const KEY = 'sb_publishable_RTQ8CSTfuHByAw1-_bbqag_NX0-kQhp'
const API = SUPABASE + '/functions/v1/api'
const MAX_ROUNDS = 30
const MAX_FILE_BYTES = 400_000
const MAX_FILES = 60

const $ = (id) => document.getElementById(id)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const store = {
  get(k) {
    try {
      return localStorage.getItem(k)
    } catch (e) {
      return null
    }
  },
  set(k, v) {
    try {
      if (v === null) localStorage.removeItem(k)
      else localStorage.setItem(k, v)
    } catch (e) {}
  }
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const utf8 = (s) => new TextEncoder().encode(s)
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2))

// ---------------------------------------------------------------------------------------------
// Account: sign-in by emailed code, the same Mirg account as the desktop app.

const SESSION_KEY = 'mirg-web-session'
let refreshing = null
let me = null

// Which app and system this is, so the account server can count web builders by computer type.
function client() {
  const ua = navigator.userAgent
  return 'web-' + (/iPhone|iPad|Android/.test(ua) ? 'mobile' : /Windows/.test(ua) ? 'windows' : /CrOS/.test(ua) ? 'chromeos' : /Mac/.test(ua) ? 'mac' : /Linux|X11/.test(ua) ? 'linux' : 'other')
}

function device() {
  let id = store.get('mirg-web-device')
  if (!id) {
    id = newId()
    store.set('mirg-web-device', id)
  }
  return id
}

function session() {
  try {
    return JSON.parse(store.get(SESSION_KEY) || 'null')
  } catch (e) {
    return null
  }
}

async function auth(path, body) {
  let response
  try {
    response = await fetch(SUPABASE + '/auth/v1/' + path, { method: 'POST', headers: { apikey: KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch (e) {
    throw new Error('Could not reach Mirg. Check your internet connection.')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.msg || data.error_description || data.message || 'Sign-in failed (' + response.status + ').')
  return data
}

function keep(data, email) {
  if (!data.access_token || !data.refresh_token) throw new Error('Sign-in did not return a session.')
  const s = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000, email: (data.user && data.user.email) || email }
  store.set(SESSION_KEY, JSON.stringify(s))
  return s
}

// Sign in with Google. Google's page opens in a small window, so whatever was typed here stays put.
// The window comes back to /create?signin=google, swaps the one-time code for a session (stored in
// this browser, which this page shares) and closes; this page sees the session and carries on.
// PKCE keeps the code useless to anyone but the page that started the sign-in.
const OAUTH_KEY = 'mirg-web-google'
const OAUTH_ERROR_KEY = 'mirg-web-google-error'
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function googleSignIn() {
  // Opened during the click, or the browser blocks it as a pop-up.
  const popup = window.open('about:blank', 'mirg-google', 'width=520,height=680')
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(verifier))))
  store.set(OAUTH_KEY, JSON.stringify({ verifier, at: Date.now() }))
  store.set(OAUTH_ERROR_KEY, null)
  const url = SUPABASE + '/auth/v1/authorize?provider=google&redirect_to=' + encodeURIComponent(location.origin + '/create?signin=google') + '&code_challenge=' + challenge + '&code_challenge_method=s256'
  if (!popup) {
    // Pop-ups blocked: sign in in this tab instead. The page finishes the sign-in when it comes back.
    location.href = url
    return new Promise(() => undefined)
  }
  popup.location.href = url
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (session()) {
        clearInterval(timer)
        return resolve()
      }
      const failed = store.get(OAUTH_ERROR_KEY)
      if (failed) {
        clearInterval(timer)
        store.set(OAUTH_ERROR_KEY, null)
        return reject(new Error(failed))
      }
      // Google's page may cut the link to its window, so a "closed" window is not trusted at once.
      if ((popup.closed && Date.now() - started > 120_000) || Date.now() - started > 600_000) {
        clearInterval(timer)
        reject(new Error('Google sign-in did not finish. Try again.'))
      }
    }, 400)
  })
}

/** Back from Google: finish signing in. True when this is the sign-in window, which then closes. */
async function finishGoogleSignIn() {
  const q = new URLSearchParams(location.search)
  if (q.get('signin') !== 'google') return false
  const h = new URLSearchParams(location.hash.slice(1))
  let pending = null
  try {
    pending = JSON.parse(store.get(OAUTH_KEY) || 'null')
  } catch (e) {}
  store.set(OAUTH_KEY, null)
  history.replaceState(null, '', '/create')
  let error = q.get('error_description') || h.get('error_description') || q.get('error') || h.get('error')
  const code = q.get('code')
  if (!error && code && pending) {
    try {
      keep(await auth('token?grant_type=pkce', { auth_code: code, code_verifier: pending.verifier }))
    } catch (e) {
      error = e.message
    }
  } else if (!error) error = 'Google sign-in did not finish. Try again.'
  if (error) store.set(OAUTH_ERROR_KEY, String(error).replace(/\+/g, ' '))
  if (window.opener || window.name === 'mirg-google') {
    document.body.innerHTML = '<p style="font:16px system-ui;padding:24px">' + (error ? 'Sign-in did not work. You can close this window.' : 'Signed in. You can close this window.') + '</p>'
    window.close()
    return true
  }
  return false
}

async function token() {
  const s = session()
  if (!s) return null
  if (s.expiresAt - Date.now() > 60_000) return s.accessToken
  refreshing =
    refreshing ||
    auth('token?grant_type=refresh_token', { refresh_token: s.refreshToken })
      .then((data) => keep(data, s.email))
      .catch(() => {
        store.set(SESSION_KEY, null)
        return null
      })
      .finally(() => {
        refreshing = null
      })
  const fresh = await refreshing
  return fresh ? fresh.accessToken : null
}

async function call(method, path, body) {
  const t = await token()
  if (!t) throw new Error('Sign in first.')
  const response = await fetch(API + path, {
    method,
    headers: Object.assign({ authorization: 'Bearer ' + t, 'x-mirg-device': device(), 'x-mirg-client': client() }, body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((data.error && data.error.message) || 'Mirg server error ' + response.status + '.')
  return data
}

async function refreshMe() {
  if (!session()) {
    me = null
    renderAccount()
    return
  }
  try {
    me = await call('GET', '/me')
  } catch (e) {
    if (!session()) me = null
  }
  renderAccount()
}

const PLAN_NAMES = { free: 'Free', pro: 'Pro', max: 'Max' }
const usd = (micros) => '$' + (micros / 1_000_000).toFixed(micros % 1_000_000 ? 2 : 0)

function renderAccount() {
  document.querySelectorAll('[data-account]').forEach((el) => {
    const s = session()
    if (!s) {
      el.innerHTML = '<button type="button" class="linklike" data-signin>Sign in</button>'
      return
    }
    let inside = '<span class="plan-text">Account</span>'
    if (me && me.allowanceMicros > 0) {
      const pct = Math.min(100, Math.round((me.usedMicros / me.allowanceMicros) * 100))
      inside = '<span class="plan-text">' + (PLAN_NAMES[me.plan] || 'Free') + ' · ' + pct + '% used</span><span class="meter"><span style="width:' + pct + '%"></span></span>'
    }
    el.innerHTML = '<a class="account-open" href="#settings" title="Settings: your account, plan and usage (' + escapeHtml(s.email) + ')">' + inside + '<span class="avatar">' + escapeHtml((s.email[0] || '?').toUpperCase()) + '</span></a>'
  })
}

/** The account part of Settings: plan, this period's usage, upgrading and billing, like the app. */
async function renderAccountSettings() {
  const body = $('account-body')
  const s = session()
  if (!s) {
    body.innerHTML = '<p class="fine">You are not signed in.</p><button type="button" class="btn small primary" data-signin>Sign in</button>'
    return
  }
  const draw = (note) => {
    body.innerHTML = ''
    const add = (html, cls) => {
      const el = document.createElement('div')
      if (cls) el.className = cls
      el.innerHTML = html
      body.appendChild(el)
      return el
    }
    add('<span class="email">' + escapeHtml(s.email) + '</span>' + (me ? '<span class="badge">' + (PLAN_NAMES[me.plan] || 'Free') + '</span>' : ''), 'account-row')
    if (!me) {
      add(note || 'Loading your plan…', 'fine')
      return
    }
    if (me.suspended) add('Your account is suspended because a payment failed or was disputed. Contact <strong>support@mirg.ai</strong> to restore it.', 'error')
    const pct = me.allowanceMicros > 0 ? Math.min(100, Math.round((me.usedMicros / me.allowanceMicros) * 100)) : 0
    // The free plan renews every 6 hours, so its reset is a time of day; paid plans renew on a date.
    const resets = !me.periodEnd ? '' : me.plan === 'free'
      ? ' · resets at ' + new Date(me.periodEnd).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : ' · resets ' + new Date(me.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    add('<div class="usage-bar"><span style="width:' + pct + '%"></span></div><div class="fine usage-line"><span>' + tokens(me.usedTokens || 0) + ' tokens used ' + (me.plan === 'free' ? 'in these 6 hours' : 'this period') + '</span><span>' + (pct >= 100 ? 'All' : pct + '%') + ' of your plan' + resets + '</span></div>', 'usage')
    if (me.free && me.free.totalMicros > 0) add(Math.min(100, Math.round((me.free.usedMicros / me.free.totalMicros) * 100)) + '% of the free plan used in all. When it is all used, upgrade to keep building.', 'fine free-total')
    if (me.gift) add('Your ' + (PLAN_NAMES[me.plan] || '') + ' plan is a gift until ' + new Date(me.gift.until).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + '.', 'fine')
    if (me.bonus && me.bonus.leftMicros > 0) add('Includes ' + usd(me.bonus.micros) + ' of free credit' + (me.bonus.until ? ', until ' + new Date(me.bonus.until).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '') + '.', 'fine')
    // Credits, bought once, on any plan: what is left, and buying more. (Max's extra usage below is
    // the automatic way; this is by hand.)
    if (me.credits && !me.suspended) {
      const box3 = add('', 'credits-box')
      const head = document.createElement('div')
      head.className = 'account-row'
      const left = document.createElement('span')
      left.className = 'fine'
      left.textContent = me.credits.leftMicros > 0 ? usd(me.credits.leftMicros) + ' of credits left. Used after your plan\'s building time runs out.' : 'Credits: pay once to keep building when your plan\'s time runs out. They do not expire.'
      head.appendChild(left)
      box3.appendChild(head)
      const amounts = document.createElement('div')
      amounts.className = 'limit-amounts'
      for (const dollars of CREDIT_AMOUNTS) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'btn small'
        b.textContent = 'Add ' + creditsLabel(dollars)
        b.onclick = async () => {
          const tab = window.open('', '_blank')
          try {
            await buyCredits(dollars, tab)
          } catch (e) {
            alert(e.message)
          }
        }
        amounts.appendChild(b)
      }
      box3.appendChild(amounts)
    }
    if (me.plan === 'free') {
      const plans = add('', 'plans')
      for (const [kind, name, price, what] of [
        ['pro', 'Pro', me.offer ? me.offer.firstMonth + ' first month, then $20 / month' : '$20 / month', 'For regular game-making: no waiting for more usage, and Claude Opus by default'],
        ['max', 'Max', '$100 / month', "For big projects and heavy use: over 5 times Pro's usage"]
      ]) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'plan'
        b.innerHTML = '<span class="plan-name">' + name + '</span><span class="plan-price">' + price + '</span><span class="fine">' + what + '</span>'
        b.onclick = () => billing('/billing/checkout?plan=' + kind)
        plans.appendChild(b)
      }
      add('Payment opens in a new tab. After paying, come back here; your plan updates within a minute.', 'fine')
    } else if (me.gift && !me.gift.card) {
      // A gifted plan with no card yet: on Max, save one for extra usage; on Pro, move up to Max.
      const row = add('', 'account-row')
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'btn small'
      const max = me.plan === 'max'
      b.textContent = max ? 'Add a card for extra usage' : 'Move up to Max'
      b.onclick = () => billing(max ? '/billing/card' : '/billing/checkout?plan=max')
      const t = document.createElement('span')
      t.className = 'fine'
      t.textContent = max
        ? 'To keep building when this month\'s usage runs out. Nothing is charged until you turn on extra usage. Opens in a new tab.'
        : 'Subscribe to Max for $100 a month. Opens in a new tab.'
      row.append(b, t)
    } else {
      const row = add('', 'account-row')
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'btn small'
      b.textContent = 'Manage billing'
      b.onclick = () => billing('/billing/portal')
      const t = document.createElement('span')
      t.className = 'fine'
      t.textContent = (me.plan === 'pro' ? 'Switch to Max, update your card or cancel.' : 'Change plan, update your card or cancel.') + ' Opens in a new tab.'
      row.append(b, t)
    }
    if (me.extra && !me.suspended) {
      const x = me.extra
      const cap = Math.round(x.capMicros / 1_000_000)
      const limits = [...new Set([40, 100, 200, 500, 1000, cap])].sort((a, b) => a - b)
      const box2 = add(
        '<label class="check"><input type="checkbox" id="extra-on"' + (x.enabled ? ' checked' : '') + ' /> Keep building when my plan runs out</label>' +
          '<p class="fine">When your Max usage is used up, Mirg charges your card ' + usd(x.blockMicros) + ' at a time for more, straight away, at the same rate as your plan. Anything you do not use carries over. If a charge fails, your account is paused until support sorts it out.</p>' +
          '<label class="inline">Most to charge per billing period <select id="extra-cap">' + limits.map((d) => '<option value="' + d + '"' + (d === cap ? ' selected' : '') + '>$' + d + '</option>').join('') + '</select></label>' +
          (x.boughtMicros > 0 || x.balanceMicros > 0 ? '<p class="fine">Charged this period: ' + usd(x.boughtMicros) + ' of ' + usd(x.capMicros) + ' · ' + usd(x.balanceMicros) + ' of extra usage left</p>' : ''),
        'extra'
      )
      const saveExtra = async () => {
        const on = box2.querySelector('#extra-on')
        const sel = box2.querySelector('#extra-cap')
        on.disabled = sel.disabled = true
        try {
          await call('POST', '/billing/extra?enabled=' + (on.checked ? 'true' : 'false') + '&cap=' + Number(sel.value))
          await refreshMe()
          draw()
        } catch (e) {
          draw(e.message)
          showAccountError(e.message)
        }
      }
      box2.querySelector('#extra-on').onchange = saveExtra
      box2.querySelector('#extra-cap').onchange = saveExtra
    }
    if (note) showAccountError(note)
  }
  const showAccountError = (message) => {
    const err = document.createElement('p')
    err.className = 'error'
    err.textContent = message
    body.appendChild(err)
  }
  const billing = async (path) => {
    // Opened now, while the click still counts, so the browser does not block it as a pop-up.
    const tab = window.open('', '_blank')
    try {
      const { url } = await call('POST', path)
      if (!/^https:\/\//.test(url)) throw new Error('The billing page address was not valid.')
      if (tab) tab.location.href = url
      else location.href = url
    } catch (e) {
      if (tab) tab.close()
      draw()
      showAccountError(e.message)
    }
  }
  draw()
  await refreshMe()
  if (!$('settings').hidden) draw(me ? '' : 'Could not reach Mirg to load your usage.')
}

window.addEventListener('focus', () => {
  // Back from paying in another tab: show the new plan.
  if (session() && !$('settings').hidden) renderAccountSettings()
})

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-signin]')) signIn().catch(() => undefined)
  if (e.target.closest('[data-signout]')) {
    const s = session()
    store.set(SESSION_KEY, null)
    me = null
    renderAccount()
    if (s) fetch(SUPABASE + '/auth/v1/logout', { method: 'POST', headers: { apikey: KEY, authorization: 'Bearer ' + s.accessToken } }).catch(() => undefined)
    if (typeof running !== 'undefined' && running) running.abort()
    // Settings and the open game belong to the account that just left: go back to the start page.
    if (location.hash) {
      history.pushState(null, '', '/create')
      route()
    }
    toast(s ? 'You are signed out' + (s.email ? ' of ' + s.email : '') + '.' : 'You are signed out.')
  }
})

let toastTimer = null
/** A short message at the bottom of the screen that fades by itself. */
function toast(text) {
  let el = document.getElementById('toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'toast'
    el.className = 'toast'
    el.setAttribute('role', 'status')
    document.body.appendChild(el)
  }
  el.textContent = text
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500)
}

/** Ask for an email and the code sent to it. Resolves once signed in; rejects if cancelled. */
/** The code step survives closing the box or reloading the page: codes stay valid for an hour. */
const PENDING_KEY = 'mirg-web-pending-signin'
function pendingSignIn() {
  try {
    const p = JSON.parse(store.get(PENDING_KEY) || 'null')
    return p && Date.now() - p.at < 55 * 60_000 ? p : null
  } catch (e) {
    return null
  }
}

function friendlyAuthError(message) {
  if (/expired|invalid/i.test(message)) return 'That code did not work. It may have expired or been mistyped: check it, or send a new code.'
  if (/rate limit|too many|seconds/i.test(message)) return 'Too many codes asked for at once. Wait a minute, then send a new code.'
  return message
}

/** Ask for an email and the code sent to it. Resolves once signed in; rejects if cancelled. */
function signIn() {
  const box = $('signin')
  const err = $('signin-error')
  let stage = 'email'
  let email = ''
  let sentAt = 0
  const showEmail = () => {
    stage = 'email'
    $('email-row').hidden = false
    $('code-row').hidden = true
    $('signin-help').hidden = true
    $('signin-google-row').hidden = false
    $('signin-code').required = false
    $('signin-go').textContent = 'Email me a code'
    $('signin-note').textContent = 'Free to try. Same account as the Mirg app.'
    setTimeout(() => $('email').focus(), 0)
  }
  const showCode = () => {
    stage = 'code'
    $('email-row').hidden = true
    $('code-row').hidden = false
    $('signin-help').hidden = false
    $('signin-google-row').hidden = true
    $('signin-code').required = true
    $('signin-go').textContent = 'Sign in'
    $('signin-note').textContent = 'We sent a code to ' + email + '. Enter it here.'
    setTimeout(() => $('signin-code').focus(), 0)
  }
  const send = async () => {
    await auth('otp', { email, create_user: true })
    sentAt = Date.now()
    store.set(PENDING_KEY, JSON.stringify({ email, at: sentAt }))
  }
  err.hidden = true
  const pending = pendingSignIn()
  if (pending) {
    email = pending.email
    sentAt = pending.at
    $('signin-code').value = ''
    showCode()
  } else showEmail()
  box.showModal()
  return new Promise((resolve, reject) => {
    const done = (ok) => {
      $('signin-form').onsubmit = null
      $('signin-cancel').onclick = null
      box.onclose = null
      box.close()
      ok ? resolve() : reject(new Error('cancelled'))
    }
    $('signin-cancel').onclick = () => done(false)
    box.onclose = () => (session() ? resolve() : reject(new Error('cancelled')))
    $('signin-google').onclick = async () => {
      err.hidden = true
      $('signin-google').disabled = true
      $('signin-note').textContent = 'Finish signing in with Google in the window that opened.'
      try {
        await googleSignIn()
        store.set(PENDING_KEY, null)
        await refreshMe()
        if (!$('start').hidden) showStart()
        done(true)
      } catch (ex) {
        err.textContent = ex.message
        err.hidden = false
        $('signin-note').textContent = "Free to try. Same account as the Mirg app."
      } finally {
        $('signin-google').disabled = false
      }
    }
    $('signin-other').onclick = () => {
      store.set(PENDING_KEY, null)
      err.hidden = true
      showEmail()
    }
    $('signin-resend').onclick = async () => {
      err.hidden = true
      const wait = 30 - Math.round((Date.now() - sentAt) / 1000)
      if (wait > 0) {
        err.textContent = 'You can send a new code in ' + wait + ' seconds.'
        err.hidden = false
        return
      }
      try {
        await send()
        $('signin-note').textContent = 'We sent a new code to ' + email + '. Use the newest one.'
      } catch (ex) {
        err.textContent = friendlyAuthError(ex.message)
        err.hidden = false
      }
    }
    $('signin-form').onsubmit = async (e) => {
      e.preventDefault()
      err.hidden = true
      $('signin-go').disabled = true
      try {
        if (stage === 'email') {
          email = $('email').value.trim().toLowerCase()
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.')
          await send()
          $('signin-code').value = ''
          showCode()
        } else {
          const code = $('signin-code').value.replace(/\s+/g, '')
          if (!code) throw new Error('Enter the code from the email.')
          keep(await auth('verify', { type: 'email', email, token: code }), email)
          store.set(PENDING_KEY, null)
          await refreshMe()
          // Show this account's own games on the start page.
          if (!$('start').hidden) showStart()
          done(true)
        }
      } catch (ex) {
        err.textContent = friendlyAuthError(ex.message)
        err.hidden = false
      } finally {
        $('signin-go').disabled = false
      }
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Saved games, in this browser.

const db = (() => {
  let opened = null
  const memory = new Map()
  const open = () =>
    (opened =
      opened ||
      new Promise((resolve) => {
        try {
          const req = indexedDB.open('mirg-create', 1)
          req.onupgradeneeded = () => req.result.createObjectStore('projects', { keyPath: 'id' })
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(null)
        } catch (e) {
          resolve(null)
        }
      }))
  const run = async (mode, fn) => {
    const d = await open()
    if (!d) return fn(null)
    return new Promise((resolve, reject) => {
      const tx = d.transaction('projects', mode)
      const req = fn(tx.objectStore('projects'))
      tx.oncomplete = () => resolve(req && req.result)
      tx.onerror = () => reject(tx.error)
    })
  }
  return {
    all: () => run('readonly', (s) => (s ? s.getAll() : { result: [...memory.values()] })).then((r) => r || [...memory.values()]),
    put: (p) => run('readwrite', (s) => (s ? s.put(p) : void memory.set(p.id, p))),
    del: (id) => run('readwrite', (s) => (s ? s.delete(id) : void memory.delete(id)))
  }
})()

let project = null
let saveTimer = null
function save() {
  if (!project) return
  project.updated = Date.now()
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => db.put(project).catch(() => undefined), 300)
}

function titleOf(files) {
  const m = /<title>([^<]{1,80})<\/title>/i.exec(files['index.html'] || '')
  return m ? m[1].trim() : null
}

// ---------------------------------------------------------------------------------------------
// Running the game: one HTML document built from the files, in a sandboxed frame.

// The game's sound, off or on; remembered on this browser.
let gameMuted = false
try {
  gameMuted = localStorage.getItem('mirg-game-muted') === '1'
} catch (e) {}
function showMuted() {
  const b = $('mute')
  if (!b) return
  b.innerHTML = (gameMuted ? 'Unmute' : 'Mute') + '<span class="wide-only"> game</span>'
  b.setAttribute('aria-pressed', String(gameMuted))
}
function setGameMuted(on) {
  gameMuted = on
  try {
    localStorage.setItem('mirg-game-muted', on ? '1' : '0')
  } catch (e) {}
  showMuted()
  if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: 'mute', on }, '*')
}

/** Runs first inside the game: reports logs, answers eval and input requests, stands in for storage. */
const BOOT = `(function(){
var P=function(m){try{m.mirg=1;parent.postMessage(m,'*')}catch(e){}};
function fmt(v,deep){try{if(typeof v==='string')return v;if(v instanceof Error)return v.stack||String(v);if(v===undefined)return 'undefined';if(typeof v==='function')return 'function '+(v.name||'');var seen=new WeakSet();var s=JSON.stringify(v,function(k,x){if(typeof x==='object'&&x!==null){if(seen.has(x))return '[circular]';seen.add(x);if(x instanceof Node)return '<'+(x.nodeName||'node').toLowerCase()+'>'}if(typeof x==='function')return undefined;return x});return s===undefined?String(v):(s.length>(deep?8000:2000)?s.slice(0,deep?8000:2000)+'…':s)}catch(e){return String(v)}}
function mem(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}
try{window.localStorage.length}catch(e){try{Object.defineProperty(window,'localStorage',{value:mem(),configurable:true});Object.defineProperty(window,'sessionStorage',{value:mem(),configurable:true})}catch(e2){}}
try{Object.defineProperty(document,'cookie',{get:function(){return ''},set:function(){},configurable:true})}catch(e){}
['log','info','warn','error','debug'].forEach(function(l){var o=console[l];console[l]=function(){try{P({type:'log',level:l==='debug'||l==='info'?'log':l,text:Array.prototype.map.call(arguments,function(a){return fmt(a)}).join(' ')})}catch(e){}return o&&o.apply(console,arguments)}});
addEventListener('error',function(e){if(e.target&&e.target!==window&&e.target.tagName){P({type:'log',level:'error',text:'Could not load '+(e.target.src||e.target.href||e.target.tagName)});return}P({type:'log',level:'error',text:(e.message||'Error')+(e.lineno?' (line '+e.lineno+(e.filename&&e.filename.indexOf('data:')!==0?' of '+e.filename.split('/').pop():'')+')':'')+(e.error&&e.error.stack?'\\n'+e.error.stack:'')})},true);
addEventListener('unhandledrejection',function(e){P({type:'log',level:'error',text:'Unhandled promise rejection: '+fmt(e.reason)})});
var FILES=window.__mirgFiles||{};
var of=window.fetch;window.fetch=function(u,o){try{var s=typeof u==='string'?u:(u&&u.url)||'';if(!/^[a-z]+:/i.test(s)){var p=s.replace(/^\\.?\\//,'').split(/[?#]/)[0];if(Object.prototype.hasOwnProperty.call(FILES,p)){var t=/\\.json$/.test(p)?'application/json':/\\.svg$/.test(p)?'image/svg+xml':'text/plain';return Promise.resolve(new Response(FILES[p],{status:200,headers:{'content-type':t}}))}}}catch(e){}return of.apply(this,arguments)};
var CODES={' ':'Space',Space:'Space',ArrowLeft:'ArrowLeft',ArrowRight:'ArrowRight',ArrowUp:'ArrowUp',ArrowDown:'ArrowDown',Enter:'Enter',Escape:'Escape',Shift:'ShiftLeft',Control:'ControlLeft',Alt:'AltLeft',Tab:'Tab',Backspace:'Backspace'};
function code(k){if(CODES[k])return CODES[k];if(/^[a-z]$/i.test(k))return 'Key'+k.toUpperCase();if(/^[0-9]$/.test(k))return 'Digit'+k;return k}
function target(){var a=document.activeElement;return a&&a!==document.body&&a!==document.documentElement?a:(document.querySelector('canvas')||document.body)}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
async function act(a){
if(a.wait){await sleep(Math.min(10000,a.wait));return}
if(a.key){var k=a.key==='Space'?' ':a.key;var o={key:k,code:code(a.key),bubbles:true,cancelable:true,composed:true};var t=target();t.dispatchEvent(new KeyboardEvent('keydown',o));await sleep(Math.min(10000,a.ms||80));t.dispatchEvent(new KeyboardEvent('keyup',o));return}
if(a.tap){var x=a.tap[0],y=a.tap[1];var el=document.elementFromPoint(x,y)||document.body;var b={clientX:x,clientY:y,bubbles:true,cancelable:true,composed:true,pointerId:1,isPrimary:true,pointerType:'mouse',button:0,buttons:1};
el.dispatchEvent(new PointerEvent('pointerdown',b));el.dispatchEvent(new MouseEvent('mousedown',b));await sleep(Math.min(10000,a.ms||60));b.buttons=0;el.dispatchEvent(new PointerEvent('pointerup',b));el.dispatchEvent(new MouseEvent('mouseup',b));el.dispatchEvent(new MouseEvent('click',b))}}
var MUTED=!!window.__mirgMuted,GAINS=[],MEDIA=[];
try{var AC=window.BaseAudioContext||window.AudioContext||window.webkitAudioContext;var DD=AC&&Object.getOwnPropertyDescriptor(AC.prototype,'destination');if(DD&&DD.get){var GW=new WeakMap();Object.defineProperty(AC.prototype,'destination',{configurable:true,get:function(){var real=DD.get.call(this);if(window.OfflineAudioContext&&this instanceof OfflineAudioContext)return real;var g=GW.get(this);if(!g){g=this.createGain();g.gain.value=MUTED?0:1;g.connect(real);GW.set(this,g);GAINS.push(g)}return g}})}}catch(e){}
try{var PLAY=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){if(MEDIA.indexOf(this)<0)MEDIA.push(this);if(MUTED)this.muted=true;return PLAY.apply(this,arguments)}}catch(e){}
function setMuted(on){MUTED=on;GAINS.forEach(function(g){try{g.gain.value=on?0:1}catch(e){}});MEDIA.concat(Array.prototype.slice.call(document.querySelectorAll('audio,video'))).forEach(function(m){try{m.muted=on}catch(e){}})}
addEventListener('message',function(e){if(e.source===parent&&e.data&&e.data.type==='mute')setMuted(!!e.data.on)});
addEventListener('message',async function(e){if(e.source!==parent)return;var m=e.data||{};
if(m.type==='eval'){try{var r;try{r=(0,eval)('('+m.code+'\\n)')}catch(se){if(!(se instanceof SyntaxError))throw se;r=(0,eval)('(async function(){'+m.code+'\\n})()')}if(r&&typeof r.then==='function')r=await r;P({type:'evalResult',id:m.id,ok:true,value:fmt(r,true)})}catch(err){P({type:'evalResult',id:m.id,ok:false,value:String(err&&err.stack||err)})}}
if(m.type==='input'){try{for(var i=0;i<(m.actions||[]).length;i++)await act(m.actions[i]);P({type:'inputDone',id:m.id,ok:true})}catch(err){P({type:'inputDone',id:m.id,ok:false,value:String(err)})}}});
try{var gc=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,o){if(/webgl/i.test(String(t))){o=Object.assign({},o||{},{preserveDrawingBuffer:true})}return gc.call(this,t,o)}}catch(e){}
// A picture of the game as the player sees it: the whole page, with each canvas drawn in its place
// (page elements such as menus, text and buttons included). If the browser will not allow that,
// the biggest canvas alone.
function canvasShot(c){var w=Math.min(800,c.width),h=Math.round(c.height*w/c.width);var out=document.createElement('canvas');out.width=w;out.height=h;var x=out.getContext('2d');x.fillStyle='#000';x.fillRect(0,0,w,h);x.drawImage(c,0,0,w,h);return out.toDataURL('image/jpeg',0.82)}
function pageShot(){return new Promise(function(done){try{
var W=innerWidth,H=innerHeight;if(W<40||H<40)return done(null);
var LAYOUT=['position','top','left','right','bottom','width','height','display','z-index','transform','transform-origin','margin','opacity','object-fit','border-radius'];
var clone=document.documentElement.cloneNode(true);
[].slice.call(clone.querySelectorAll('script,noscript,iframe,video,audio')).forEach(function(n){n.remove()});
var from=[].slice.call(document.querySelectorAll('canvas')),to=[].slice.call(clone.querySelectorAll('canvas'));
from.forEach(function(c,i){var d=to[i];if(!d)return;var img=document.createElement('img');
for(var a=0;a<c.attributes.length;a++)if(c.attributes[a].name!=='width'&&c.attributes[a].name!=='height')img.setAttribute(c.attributes[a].name,c.attributes[a].value);
var cs=getComputedStyle(c),r=c.getBoundingClientRect(),st=LAYOUT.map(function(k){return k+':'+cs.getPropertyValue(k)}).join(';');
img.setAttribute('style',st+';width:'+r.width+'px;height:'+r.height+'px');
try{img.src=c.width*c.height>0?c.toDataURL():''}catch(e){}d.replaceWith(img)});
var vals=[].slice.call(document.querySelectorAll('input,textarea,select')),cv=[].slice.call(clone.querySelectorAll('input,textarea,select'));
vals.forEach(function(el,i){var d=cv[i];if(!d)return;if(el.type==='checkbox'||el.type==='radio'){if(el.checked)d.setAttribute('checked','')}else if(el.tagName==='TEXTAREA')d.textContent=el.value;else if(el.tagName!=='SELECT')d.setAttribute('value',el.value)});
var body=clone.querySelector('body');if(body)body.style.margin=getComputedStyle(document.body).margin;
clone.style.width=W+'px';clone.style.height=H+'px';clone.style.overflow='hidden';
var xml=new XMLSerializer().serializeToString(clone);
var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'"><foreignObject x="0" y="0" width="100%" height="100%">'+xml+'</foreignObject></svg>';
var pic=new Image(),t=setTimeout(function(){done(null)},2500);
pic.onload=function(){clearTimeout(t);try{var w=Math.min(800,W),h=Math.round(H*w/W);var out=document.createElement('canvas');out.width=w;out.height=h;var x=out.getContext('2d');
var bg=getComputedStyle(document.body).backgroundColor;x.fillStyle=bg&&bg!=='rgba(0, 0, 0, 0)'?bg:(getComputedStyle(document.documentElement).backgroundColor||'#fff');if(x.fillStyle==='rgba(0, 0, 0, 0)')x.fillStyle='#fff';x.fillRect(0,0,w,h);
x.drawImage(pic,0,0,w,h);done(out.toDataURL('image/jpeg',0.82))}catch(e){done(null)}};
pic.onerror=function(){clearTimeout(t);done(null)};
pic.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)}catch(e){done(null)}})}
addEventListener('message',async function(e){if(e.source!==parent)return;var m=e.data||{};if(m.type!=='snapshot')return;var url=null;
try{url=await pageShot()}catch(err){url=null}
if(!url){try{var cs=[].slice.call(document.querySelectorAll('canvas')).filter(function(c){var r=c.getBoundingClientRect();return c.width*c.height>0&&r.width>40&&r.height>40}).sort(function(a,b){return b.width*b.height-a.width*a.height});if(cs[0])url=canvasShot(cs[0])}catch(err){url=null}}
P({type:'snapshotResult',id:m.id,ok:true,value:url})});
addEventListener('load',function(){P({type:'loaded'})});
})();`

function b64(text) {
  const bytes = utf8(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function resolvePath(fromFile, spec) {
  const parts = spec.startsWith('/') ? [] : fromFile.split('/').slice(0, -1)
  for (const seg of spec.replace(/^\//, '').split(/[?#]/)[0].split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

const isLocal = (url) => url && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)

/** Build one HTML document that runs the project with no server: modules become data: URLs. */
function bundle(files) {
  const memo = new Map()
  const moduleUrl = (path, stack) => {
    if (memo.has(path)) return memo.get(path)
    if (stack.includes(path)) throw new Error('Modules import each other in a circle: ' + [...stack, path].join(' → '))
    const src = files[path]
    if (src === undefined) throw new Error('A file imports ' + path + ', which does not exist.')
    const url = 'data:text/javascript;base64,' + b64(rewrite(src, path, [...stack, path]) + '\n//# sourceURL=' + path)
    memo.set(path, url)
    return url
  }
  const rewrite = (src, from, stack) =>
    src.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g, (all, head, q, spec) => {
      if (!isLocal(spec) || !/^(\.{1,2}\/|\/)/.test(spec)) return all
      const path = resolvePath(from, spec)
      return head + q + moduleUrl(path, stack) + q
    })

  const doc = new DOMParser().parseFromString(files['index.html'] || '<!doctype html><html><head></head><body></body></html>', 'text/html')
  for (const s of [...doc.querySelectorAll('script')]) {
    const src = s.getAttribute('src')
    const isModule = (s.getAttribute('type') || '').toLowerCase() === 'module'
    if (src && isLocal(src)) {
      const path = resolvePath('index.html', src)
      if (files[path] === undefined) {
        s.removeAttribute('src')
        s.textContent = 'console.error(' + JSON.stringify('Could not load ' + src + ': there is no such file.') + ')'
        continue
      }
      if (isModule) s.setAttribute('src', moduleUrl(path, ['index.html']))
      else {
        s.removeAttribute('src')
        s.textContent = files[path] + '\n//# sourceURL=' + path
      }
    } else if (!src && isModule) {
      s.textContent = rewrite(s.textContent, 'index.html', ['index.html'])
    }
  }
  for (const l of [...doc.querySelectorAll('link[rel="stylesheet"]')]) {
    const href = l.getAttribute('href')
    if (!isLocal(href)) continue
    const style = doc.createElement('style')
    style.textContent = files[resolvePath('index.html', href)] || ''
    l.replaceWith(style)
  }
  // Small text files (levels, SVG art) can be fetched or shown by relative path.
  const data = {}
  for (const [p, text] of Object.entries(files)) if (/\.(json|txt|csv|svg|glsl|frag|vert)$/i.test(p)) data[p] = text
  for (const img of [...doc.querySelectorAll('img[src]')]) {
    const p = resolvePath('index.html', img.getAttribute('src'))
    if (isLocal(img.getAttribute('src')) && /\.svg$/i.test(p) && files[p] !== undefined) img.setAttribute('src', 'data:image/svg+xml;base64,' + b64(files[p]))
  }
  const boot = doc.createElement('script')
  boot.textContent = 'window.__mirgFiles=' + JSON.stringify(data).replace(/</g, '\\u003c') + ';window.__mirgMuted=' + (gameMuted ? 'true' : 'false') + ';\n' + BOOT
  doc.head.insertBefore(boot, doc.head.firstChild)
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}

let frame = null
let logs = []
let loaded = null
const pending = new Map()

/** Stop the game: its page, sound and all, until Restart game (or the agent) runs it again. */
function stopGame() {
  if (frame) frame.remove()
  frame = null
  pending.delete('load')
  $('game-empty').hidden = false
  $('game-empty').textContent = 'The game is stopped. Press Restart game to play it again.'
}

function runGame() {
  logs = []
  renderErrors()
  $('game-empty').hidden = true
  if (frame) frame.remove()
  if (!project || !project.files['index.html']) {
    $('game-empty').hidden = false
    $('game-empty').textContent = 'Your game will appear here.'
    frame = null
    return Promise.resolve(false)
  }
  frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock')
  frame.setAttribute('allow', 'fullscreen; autoplay; gamepad')
  frame.title = 'Your game'
  let html
  try {
    html = bundle(project.files)
  } catch (e) {
    // Nothing of the game can run, so there is nothing to wait for.
    logs.push({ level: 'error', text: e.message })
    frame.srcdoc = '<!doctype html><body style="color:#ccc;font:14px sans-serif;padding:20px;background:#111">' + escapeHtml(e.message) + '</body>'
    $('game-wrap').appendChild(frame)
    fitDevice()
    renderErrors()
    return Promise.resolve(true)
  }
  loaded = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 8000)
    pending.set('load', () => {
      clearTimeout(t)
      resolve(true)
    })
  })
  frame.srcdoc = html
  $('game-wrap').appendChild(frame)
  fitDevice()
  renderErrors()
  return loaded
}

window.addEventListener('message', (e) => {
  if (!frame || e.source !== frame.contentWindow) return
  const m = e.data
  if (!m || !m.mirg) return
  if (m.type === 'log') {
    logs.push({ level: m.level, text: String(m.text).slice(0, 4000) })
    if (logs.length > 300) logs.splice(0, logs.length - 300)
    if (m.level === 'error') renderErrors()
  } else if (m.type === 'loaded') {
    const f = pending.get('load')
    pending.delete('load')
    if (f) f()
  } else if (m.id && pending.has(m.id)) {
    const f = pending.get(m.id)
    pending.delete(m.id)
    f(m)
  }
})

function renderErrors() {
  const n = logs.filter((l) => l.level === 'error').length
  $('errors').hidden = n === 0
  $('errors').textContent = (n === 1 ? '1 error' : n + ' errors') + ' · Fix'
  if (n) autoFixSoon()
}

// Errors while you play: when the game shows console errors and Mirg is not working on it, Mirg is
// asked to fix them, once for each different error, and at most 3 times a visit, so a stubborn error
// never keeps spending the plan. Pressing the "N errors · Fix" label asks straight away, every time.
// Not while there is a message being typed: that would send ahead of it; the label still works.
const autoFixed = new Set()
let autoFixes = 0
let autoFixTimer = null
function errorKey(text) {
  return String(text).replace(/\d+/g, '#').slice(0, 200)
}
function autoFixSoon() {
  clearTimeout(autoFixTimer)
  // A moment for errors that come together to be sent together.
  autoFixTimer = setTimeout(() => {
    if (running || !project || autoFixes >= 3 || $('input').value.trim()) return
    const fresh = logs.filter((l) => l.level === 'error' && !autoFixed.has(errorKey(l.text)))
    if (!fresh.length) return
    autoFixes++
    fixErrors(true)
  }, 3000)
}
function fixErrors(auto) {
  const errors = logs.filter((l) => l.level === 'error')
  if (!errors.length || !project) return
  errors.forEach((l) => autoFixed.add(errorKey(l.text)))
  const unique = [...new Set(errors.map((l) => l.text))].slice(0, 8)
  const text =
    (auto ? 'While the game was running it showed ' : 'The game showed ') +
    (unique.length === 1 ? 'this error' : 'these errors') +
    ' in the console:\n\n' +
    unique.map((t) => '- ' + t.slice(0, 1500)).join('\n') +
    '\n\nFind the cause and fix it, then run the game to check it is gone.'
  if (running) {
    queue.push({ text, files: [] })
    renderQueue()
    return
  }
  agent(text)
}

function ask(message, timeout) {
  if (!frame) return Promise.resolve({ ok: false, value: 'The game is not running. Call run_game first.' })
  const id = newId()
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, value: 'The game did not answer within ' + timeout / 1000 + ' seconds (it may be frozen in a loop).' })
    }, timeout)
    pending.set(id, (m) => {
      clearTimeout(t)
      resolve(m)
    })
    frame.contentWindow.postMessage(Object.assign({ id }, message), '*')
  })
}

function logText(entries, max) {
  if (!entries.length) return 'Console: (nothing)'
  const errors = entries.filter((l) => l.level === 'error')
  const shown = entries.slice(-max)
  return (errors.length ? errors.length + ' error(s).\n' : 'No errors.\n') + 'Console:\n' + shown.map((l) => '[' + l.level + '] ' + l.text).join('\n')
}

// ---------------------------------------------------------------------------------------------
// The agent's tools.

const TOOLS = [
  { name: 'list_files', description: 'List the files in the project with their sizes.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'read_file',
    description: 'Read a text file from the project.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the project, e.g. "js/main.js".' } }, required: ['path'] }
  },
  {
    name: 'write_file',
    description: 'Create a file or replace its whole content. Use for new files and full rewrites; prefer edit_file for small changes. For a file longer than about 250 lines, write the first part here and add the rest with append_file.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
  },
  {
    name: 'append_file',
    description: 'Add text to the end of a file, creating it if needed. Use it to write a long file in parts of up to about 250 lines each, one part per reply.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
  },
  {
    name: 'edit_file',
    description: 'Replace text in a file. old_string must appear exactly once unless replace_all is true. Include enough surrounding lines to make it unique.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
      required: ['path', 'old_string', 'new_string']
    }
  },
  { name: 'delete_file', description: 'Delete a file from the project.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  {
    name: 'run_game',
    description: 'Restart the game in the Game tab from the current files and report what it printed: errors, warnings and logs from loading and its first two seconds.',
    input_schema: { type: 'object', properties: {} }
  },
  { name: 'game_logs', description: 'The console output of the running game since it last started.', input_schema: { type: 'object', properties: {} } }
]

function checkPath(p) {
  const path = String(p || '')
    .trim()
    .replace(/^\.?\//, '')
  if (!path || path.length > 200 || path.split('/').some((s) => s === '..' || s === '') || !/^[\w./ -]+$/.test(path)) throw new Error('Use a simple path inside the project, like "js/game.js".')
  return path
}

const clip = (text, max) => (text.length > max ? text.slice(0, max) + '\n…' : text)
const diffLines = (from, to) =>
  from
    .split('\n')
    .map((l) => '- ' + l)
    .concat(to.split('\n').map((l) => '+ ' + l))
    .join('\n')

/** Runs one tool. Returns what the model reads (text) and what the chat shows (title, detail). */
async function runTool(name, input) {
  const files = project.files
  switch (name) {
    case 'list_files': {
      const list = Object.keys(files).sort()
      const text = list.length ? list.map((p) => p + ' (' + utf8(files[p]).length + ' bytes)').join('\n') : 'The project is empty.'
      return { text, title: 'Listed the files', detail: text }
    }
    case 'read_file': {
      const path = checkPath(input.path)
      if (files[path] === undefined) throw new Error('There is no file ' + path + '.')
      const t = files[path]
      return { text: t.length > 60000 ? t.slice(0, 60000) + '\n…(file continues; it is ' + t.length + ' characters long)' : t, title: 'Read ' + path }
    }
    case 'write_file': {
      const path = checkPath(input.path)
      const content = String(input.content == null ? '' : input.content)
      if (utf8(content).length > MAX_FILE_BYTES) throw new Error('That file is too big for Mirg on the web. Split it into smaller modules.')
      if (files[path] === undefined && Object.keys(files).length >= MAX_FILES) throw new Error('The project has too many files. Combine some.')
      const existed = files[path] !== undefined
      files[path] = content
      fileChanged(path)
      const lines = content.split('\n').length
      return { text: (existed ? 'Replaced ' : 'Created ') + path + ' (' + lines + ' lines).', title: (existed ? 'Rewrote ' : 'Created ') + path + ' · ' + lines + (lines === 1 ? ' line' : ' lines'), detail: clip(content, 8000), changed: true }
    }
    case 'append_file': {
      const path = checkPath(input.path)
      const content = String(input.content == null ? '' : input.content)
      const next = (files[path] || '') + content
      if (utf8(next).length > MAX_FILE_BYTES) throw new Error('That file is too big for Mirg on the web. Split it into smaller modules.')
      if (files[path] === undefined && Object.keys(files).length >= MAX_FILES) throw new Error('The project has too many files. Combine some.')
      files[path] = next
      fileChanged(path)
      const added = content.split('\n').length
      const total = next.split('\n').length
      return { text: 'Added ' + added + ' lines to ' + path + ' (' + total + ' lines now).', title: 'Added to ' + path + ' · ' + total + ' lines', detail: clip(content, 8000), changed: true }
    }
    case 'edit_file': {
      const path = checkPath(input.path)
      const t = files[path]
      if (t === undefined) throw new Error('There is no file ' + path + '.')
      const from = String(input.old_string || '')
      const to = String(input.new_string == null ? '' : input.new_string)
      if (!from) throw new Error('old_string is empty.')
      const count = t.split(from).length - 1
      if (count === 0) throw new Error('old_string was not found in ' + path + '. Read the file and copy the text exactly.')
      if (count > 1 && !input.replace_all) throw new Error('old_string appears ' + count + ' times in ' + path + '. Add surrounding lines to make it unique, or set replace_all.')
      files[path] = input.replace_all ? t.split(from).join(to) : t.replace(from, () => to)
      fileChanged(path)
      return { text: 'Edited ' + path + (count > 1 ? ' (' + count + ' places)' : '') + '.', title: 'Edited ' + path, detail: clip(diffLines(from, to), 8000), changed: true }
    }
    case 'delete_file': {
      const path = checkPath(input.path)
      if (files[path] === undefined) throw new Error('There is no file ' + path + '.')
      delete files[path]
      fileChanged(path)
      return { text: 'Deleted ' + path + '.', title: 'Deleted ' + path, changed: true }
    }
    case 'run_game': {
      if (!files['index.html']) throw new Error('There is no index.html yet, so there is nothing to run.')
      showTab('game')
      const ok = await runGame()
      await sleep(2000)
      const errors = logs.filter((l) => l.level === 'error').length
      const text = (ok ? 'The game loaded.' : 'The page did not finish loading within 8 seconds.') + '\n' + logText(logs, 60)
      return { text, title: 'Ran the game: ' + (errors ? errors + (errors === 1 ? ' error' : ' errors') : 'no errors'), detail: logText(logs, 60), bad: errors > 0, ran: true }
    }
    case 'game_logs': {
      const text = logText(logs, 120)
      return { text, title: 'Read the console', detail: text }
    }
    default:
      throw new Error('Unknown tool ' + name)
  }
}

function toolLabel(name) {
  return (
    {
      write_file: 'Writing a file',
      append_file: 'Writing a file',
      edit_file: 'Editing a file',
      read_file: 'Reading a file',
      delete_file: 'Deleting a file',
      list_files: 'Looking at the files',
      run_game: 'Running the game',
      game_logs: 'Reading the console'
    }[name] || 'Working'
  )
}

function fileChanged(path) {
  const t = titleOf(project.files)
  if (t && t !== project.name) {
    project.name = t
    $('title').textContent = t
    document.title = t + ' · Mirg'
  }
  save()
  if (!$('code').hidden && !dirty) renderFiles(path)
}

// ---------------------------------------------------------------------------------------------
// Choices: model, thinking level, preview size. Remembered in this browser.

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', group: 'Claude', hint: 'Best for building games. The default.' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', group: 'Claude', hint: 'Faster and half the cost.' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', group: 'Claude', hint: 'Fastest and cheapest. Good for small tweaks.', effort: false },
  { id: 'claude-fable-5-2', label: 'Fable 5.2', group: 'Claude', hint: 'Most capable, most expensive.' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', group: 'OpenAI', hint: "OpenAI's most capable model." },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', group: 'OpenAI', hint: 'Near-Astra quality at lower cost.' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', group: 'OpenAI', hint: "OpenAI's fastest, cheapest model." },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', group: 'Google', hint: "Google's flagship." },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', group: 'Google', hint: "Google's previous flagship." },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', group: 'Google', hint: 'Fast and inexpensive.' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', group: 'More models', hint: 'The previous Fable.' }
]
const EFFORTS = [
  { id: 'low', label: 'Low', hint: 'Fastest and uses the fewest tokens. Good for small changes.' },
  { id: 'medium', label: 'Medium', hint: 'Balanced. Right for most games.' },
  { id: 'high', label: 'High', hint: 'Most careful, slower, and uses the most tokens. For big or tricky games.' }
]
const DEVICES = { portrait: [390, 844], landscape: [844, 390] }

const settings = (() => {
  let saved = {}
  try {
    saved = JSON.parse(store.get('mirg-web-settings') || '{}') || {}
  } catch (e) {}
  return Object.assign({ model: null, effort: 'medium', device: 'desktop' }, saved)
})()
const keepSettings = () => store.set('mirg-web-settings', JSON.stringify(settings))
// Everyone starts on Opus, the free plan included, so a first game impresses.
const currentModel = () => (MODELS.some((m) => m.id === settings.model) ? settings.model : 'claude-opus-5-5')
const hasEffort = (model) => !MODELS.some((m) => m.id === model && m.effort === false)

function renderPickers() {
  const model = currentModel()
  const fill = (el, list, value, label) => {
    el.innerHTML = ''
    let group = null
    for (const x of list) {
      if (x.group && (!group || group.label !== x.group)) {
        group = document.createElement('optgroup')
        group.label = x.group
        el.appendChild(group)
      }
      const o = document.createElement('option')
      o.value = x.id
      o.textContent = label(x)
      o.title = x.hint
      ;(x.group ? group : el).appendChild(o)
    }
    el.value = value
    el.title = (list.find((x) => x.id === value) || {}).hint || ''
  }
  fill($('pick-model'), MODELS, model, (m) => m.label)
  fill($('pick-effort'), EFFORTS, settings.effort, (e) => 'Think: ' + e.label)
  $('pick-effort').hidden = !hasEffort(model)
  fill($('start-model'), MODELS, model, (m) => m.label)
  fill($('start-effort'), EFFORTS, settings.effort, (e) => 'Think: ' + e.label)
  $('start-effort').hidden = !hasEffort(model)
  $('device').value = settings.device
}

$('start-model').onchange = (e) => {
  settings.model = e.target.value
  keepSettings()
  renderPickers()
}
$('start-effort').onchange = (e) => {
  settings.effort = e.target.value
  keepSettings()
  renderPickers()
}
$('pick-model').onchange = (e) => {
  settings.model = e.target.value
  keepSettings()
  renderPickers()
}
$('pick-effort').onchange = (e) => {
  settings.effort = e.target.value
  keepSettings()
  renderPickers()
}
$('device').onchange = (e) => {
  settings.device = e.target.value
  keepSettings()
  fitDevice()
}

/** Shows the game at a phone's size, scaled down to fit the pane, or filling it. */
function fitDevice() {
  const wrap = $('game-wrap')
  const size = DEVICES[settings.device]
  wrap.classList.toggle('device', Boolean(size))
  if (!frame) return
  if (!size) {
    frame.style.width = frame.style.height = frame.style.transform = ''
    return
  }
  const scale = Math.min(1, (wrap.clientWidth - 40) / size[0], (wrap.clientHeight - 40) / size[1])
  frame.style.width = size[0] + 'px'
  frame.style.height = size[1] + 'px'
  frame.style.transform = scale < 1 ? 'scale(' + scale + ')' : ''
}
window.addEventListener('resize', fitDevice)

function deviceNote() {
  let note = ''
  const size = DEVICES[settings.device]
  if (size) note += '\n\n[The Game tab is showing a phone preview, ' + size[0] + '×' + size[1] + ' (' + settings.device + '). The game should fit that screen and be playable by touch.]'
  return note
}

// ---------------------------------------------------------------------------------------------
// The agent loop.

const SYSTEM = `You are the game-building agent in Mirg on the web: the user describes a game in this chat and you build it as a web game that runs in the Game tab next to the chat, in their browser. The user sees this chat, a Game tab where the game runs, and a Code tab with the files. You work with tools: you write the files, run the game, read its state and play it.

# Who you are working with
Often a beginner, often young, sometimes on a school Chromebook. Talk about the game in plain, friendly language, keep replies short, and never paste code into the chat: put it in files. Make the change rather than asking permission. Ask a question only when a decision is really theirs (the feel or theme of the game) and you cannot reasonably choose. Keep content suitable for all ages.

# What you can build here
Web games only: index.html at the top of the project plus ES modules, with no build step and no npm. Load libraries from a CDN through an import map (Three.js for 3D, Phaser for 2D arcade games, or plain Canvas 2D for simple ones). Text files only: there is no image or sound generation here, so draw art in code (canvas shapes, SVG, simple 3D geometry and materials, particles) and make sounds with the Web Audio API. Make it look deliberate: a consistent palette, readable shapes, some juice like easing and screen shake. Keep level data in JS modules or small JSON files.
If the user asks for Godot, Unity, Unreal, Roblox, Minecraft mods, pygame or a native app, say in one sentence that those need the Mirg desktop app (mirg.ai/download, Mac and Windows) and offer to make a web version here instead.

# How to work
The loop is: build, run, fix. You do not playtest here: the user plays the game themselves and tells you what to change.
- Write all the files of a small game in one reply. A single reply must not write more than about 250 lines of code in total, thinking included in its length: a longer reply is cut off and the user pays for it without getting anything. For a bigger game, split the code into modules of up to about 200 lines and write one per reply; write a longer file in parts (write_file with the first part, then append_file in the following replies).
- Plan briefly before writing code: the plan is not shown to the user and counts toward the reply's length.
- Then call run_game once. Errors it reports are yours to fix before you reply; when it reports none, stop and hand the game over.
- Every step costs the user part of their plan, so do not re-read files you just wrote or re-run the game when nothing changed.
- Match the build to the request: "a simple Pong game" wants a small, clean game, not title screens, settings and systems nobody asked for.
- Finish with a short summary of what changed and how to play (the controls), not a list of files.

# Every game
- Shared games are often opened on phones, so add simple touch controls as well as keyboard and mouse (tap, swipe, or a few large on-screen buttons shown only on touch devices), size the canvas to the window and handle resizing, and start audio on the first input.
- The game runs in a sandboxed frame. Do not rely on cookies or on fetching files that are not in the project.
- Give index.html a <title> with the game's name.
- No crypto: do not build anything with cryptocurrency. That means no crypto wallets, MetaMask or other wallet connections, web3 or blockchain libraries, wallet addresses, real coins or tokens such as Bitcoin or Ethereum, NFTs, and no crypto-themed games. If the user asks for one, say Mirg does not make crypto games for now and offer the same idea without crypto (for example in-game coins). Mirg holds any shared game that mentions crypto.

# Leaderboards and high scores
Mirg hosts public leaderboards, so never use Firebase, Supabase or any other backend, and never ask for keys. Load <script src="https://play.mirg.ai/_mirg/scores.js"></script> in index.html. Set MirgScores.name from a name box, send a finished run with await MirgScores.submit(score), and show the board from await MirgScores.top(), which returns { scores: [{ rank, name, score }], you }. Use lower: true for times and always set min and max so impossible scores are refused. The helper never throws; show its error message if a result has one. Until the game is shared, MirgScores.online is false and scores stay on this device: label the board "On this device" then, and tell the user the public leaderboard starts once they share the game.

# Online multiplayer
Use PeerJS with Mirg's relay: load <script src="https://play.mirg.ai/_mirg/online.js"></script> and create peers with new Peer(id, { config: { iceServers: await MirgOnline.iceServers() } }). Never hard-code STUN or TURN servers or use public relays. Keep lobby codes short, show clear connecting and failure messages, and let the host keep playing if a guest drops.

# Sharing
The Share button at the top gives the user a link anyone can play on a computer or a phone, and can list the game on mirg.ai's games page. Suggest it when the game is fun and working.`

const SUMMARY_REQUEST =
  'Pause the task. This conversation is about to be replaced by a summary so the work can continue with a fresh context. ' +
  'Write that summary now, as plain text, without calling any tools. Include: what the user asked for and any preferences they stated; ' +
  'what the game is and how it is structured (key files and what each does, libraries, controls); what has been done and verified; ' +
  'what you were in the middle of and the exact next steps; known bugs or open questions. Be specific enough that someone could carry on ' +
  'without seeing the earlier messages.'
/** Past this many tokens of conversation, it is summarized before the next message, so each step stays cheap. */
const COMPACT_AT = 150_000

const IDEAS = [
  "A platformer where a fox collects coins and dodges spikes",
  "A space shooter with waves of aliens and a boss",
  "Snake, but the snake is a train picking up passengers",
  "A 3D maze where you escape a ghost",
  "A flappy-style game with a paper plane in a windy city",
  "A two-player tank battle on one keyboard",
  "A cozy fishing game on a lake at sunset",
  "A runner where a cat jumps across rooftops at night",
  "Breakout, but the bricks fight back",
  "A tower defense game where snowmen protect a cookie",
  "A racing game with bumper cars on ice",
  "A puzzle game where you guide water to thirsty plants",
  "A dungeon crawler where you play as a tiny knight",
  "A game where you stack wobbly animals as high as you can",
  "Whack-a-mole with robots popping out of pipes",
  "A rhythm game where you tap to the beat to make a dragon dance",
  "A soccer game with two players and a giant bouncy ball",
  "An endless jumper where a frog climbs lily pads into the sky",
  "A memory card game with space creatures",
  "A pirate ship battle where you aim cannons with the mouse",
  "A 3D marble rolling down a twisty sky track",
  "A zombie survival game where you build walls before night",
  "A game where you're a bee pollinating flowers before winter",
  "Asteroids, but you're a vacuum cleaner in space",
  "A golf game on tiny floating islands",
  "A typing game where words fall like meteors",
  "A cooking game where orders pile up faster and faster",
  "A stealth game where a raccoon sneaks snacks from a campsite",
  "A pinball table themed like a haunted house",
  "A sliding block puzzle where you free a trapped penguin",
  "A volcano escape where lava rises as you climb",
  "A 3D snowboarding game down a mountain with jumps",
  "A game where you draw lines to bounce a ball into a cup",
  "A farming game where you grow giant vegetables for a fair",
  "A boxing game between two kangaroos",
  "An underwater game where a submarine explores glowing caves",
  "A hide-and-seek game against a sneaky AI owl",
  "A one-button game where a rocket dodges satellites",
  "A Tetris-like game with falling cats that have to fit together",
  "A wizard duel where you cast spells by drawing shapes",
  "A minigolf course built inside a kitchen",
  "A dodgeball game against a team of robots",
  "A sky island builder where you connect islands with bridges",
  "A firefighter game where you spray water on a burning city",
  "A slingshot game where you launch a hamster at towers",
  "A 3D driving game delivering pizzas before they get cold",
  "A space station where you keep the oxygen from running out",
  "A ghost that has to scare everyone in a house before sunrise",
  "A balloon pop game with tricky moving targets",
  "A jungle swing game where a monkey swings vine to vine",
  "A card battler with elemental monsters",
  "A game where you herd sheep with a sheepdog",
  "Pong, but the paddles shrink every time you score",
  "A treasure hunt on a pirate island with a map and clues",
  "A 2D mining game where you dig deeper for rare gems",
  "A bullet-hell game with colorful patterns and a giant jellyfish boss",
  "A parking game where you squeeze cars into tight spots",
  "A ninja game where you slice fruit thrown in the air",
  "An air hockey game against the computer",
  "A game where you guide a lost robot home through traffic",
  "A 3D bowling alley in outer space",
  "A survival game on a raft in the ocean",
  "A connect-the-pipes puzzle to light up a city",
  "A game where you're a shark eating smaller fish to grow",
  "A knight jousting tournament with timing-based hits",
  "A chicken crossing busy roads and rivers",
  "A trivia game show with a silly robot host",
  "A snowball fight in a winter village",
  "A 3D paper airplane flying through a forest",
  "A space trading game between planets with prices that change",
  "A game where you defend a castle by drawing walls",
  "A bubble shooter where you match colors to clear the board",
  "A skateboarding game with tricks and combos",
  "A detective game where you find the hidden clues in a room",
  "A haunted mansion escape room with puzzles",
  "A game where a dragon protects its eggs from knights",
  "A lemonade stand business game with weather and prices",
  "A horse race where you time your boosts",
  "A game where you bounce between planets using gravity",
  "A beat-'em-up where a grandma fights off robots with a broom",
  "A 3D cube that rolls across a puzzle grid",
  "An ant colony game where you gather food and dig tunnels",
  "A word puzzle where you unscramble words before time runs out",
  "A rescue helicopter saving people from a flood",
  "A battle royale with blobs that grow by eating dots",
  "A night sky game where you connect stars into constellations",
  "A game where you sort recycling as it speeds down a belt",
  "A basketball free throw challenge with wind",
  "A train conductor game where you switch tracks to avoid crashes",
  "A tiny planet you walk around to plant trees",
  "A sword fighting game with blocking and parrying",
  "A game where you guide a jellyfish through a coral reef",
  "A cake stacking game where layers slide side to side",
  "A laser puzzle where you rotate mirrors to hit targets",
  "A dinosaur running from a meteor shower",
  "A two-player racing game on a split screen",
  "A garden defense game against hungry snails",
  "A 3D obstacle course where you jump between spinning platforms",
  "A magic potion game where you mix ingredients to match orders",
  "A space rescue where you tow broken ships back to base"
]

let running = null
let startedAt = 0
let queue = []
let queuePaused = false

function chat() {
  return project.chats.find((c) => c.id === project.chatId) || project.chats[0]
}

// Each model vendor has its own conversation format. A chat keeps its history in the format of the
// vendor it was started with (chat.provider); switching to another vendor's model starts that
// vendor afresh with a recap of the chat, as the desktop app does.

const providerOf = (model) => (/^gpt-/.test(model) ? 'openai' : /^gemini-/.test(model) ? 'gemini' : 'anthropic')
const PROVIDER_NAMES = { anthropic: 'Claude', openai: 'GPT', gemini: 'Gemini' }

/** The path and content of a write that was cut off part-way, read from its unfinished JSON. */
function partialWrite(raw) {
  const path = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)
  const content = /"content"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw)
  if (!path || !content) return null
  // An escape cut in half at the very end is dropped.
  const body = content[1].replace(/\\u[0-9a-fA-F]{0,3}$/, '').replace(/(^|[^\\])((?:\\\\)*)\\$/, '$1$2')
  try {
    return { path: JSON.parse('"' + path[1] + '"'), content: JSON.parse('"' + body + '"') }
  } catch (e) {
    return null
  }
}

/** File tools whose finished calls are still worth running when the reply around them was cut off. */
const SALVAGED = ['write_file', 'append_file', 'edit_file', 'delete_file']

/**
 * Keeps what a cut-off reply had done: file calls that finished before the cut are run as they
 * are, and a write cut off part-way is saved up to its last whole line. Returns one entry per
 * call kept, for the chat and for the note to the model.
 */
async function salvage(cutCalls) {
  const kept = []
  for (const call of cutCalls) {
    if (!SALVAGED.includes(call.name)) continue
    let input = null
    try {
      input = JSON.parse(call.raw || '')
    } catch (e) {}
    if (input && typeof input === 'object') {
      // A whole call: run it as if the reply had finished.
      try {
        const r = await runTool(call.name, input)
        kept.push({ id: call.id, title: r.title, detail: r.detail, said: r.text })
      } catch (e) {}
      continue
    }
    if (call.name !== 'write_file' && call.name !== 'append_file') continue
    const w = partialWrite(call.raw || '')
    if (!w) continue
    let path
    try {
      path = checkPath(w.path)
    } catch (e) {
      continue
    }
    // Stop at the last whole line, so the next part starts cleanly.
    const content = w.content.slice(0, w.content.lastIndexOf('\n') + 1)
    if (!content.trim()) continue
    const next = call.name === 'append_file' ? (project.files[path] || '') + content : content
    if (utf8(next).length > MAX_FILE_BYTES) continue
    project.files[path] = next
    fileChanged(path)
    const lines = content.split('\n').length - 1
    const total = next.split('\n').length - 1
    const tail = content.trimEnd().split('\n').slice(-3).join('\n')
    kept.push({
      id: call.id,
      title: 'Saved the first ' + lines + ' lines of ' + path + ' (reply was cut off)',
      detail: clip(content, 8000),
      said: path + ' was cut off part-way; it now has ' + total + ' lines, ending with:\n' + tail
    })
  }
  return kept
}

/**
 * Lines of code a reply can safely hold, given the output tokens the cut-off reply reached.
 * About a third of the limit goes to code (a line is ~12 tokens), leaving room for thinking.
 */
const linesFor = (tokens) => Math.max(40, Math.min(250, Math.floor((tokens || 12000) / 40 / 10) * 10))

/** What the model is told after a reply was cut off for being too long, sized to the limit it hit. */
function cutNote(kept, tokens) {
  const limit = tokens ? ' (about ' + Math.round(tokens / 100) * 100 + ' tokens, and thinking counts toward it)' : ''
  const saved = kept.length ? 'What it had done was kept:\n' + kept.map((k) => '- ' + k.said).join('\n') + '\nNothing else in it was run.' : 'Nothing in it was run or saved.'
  return (
    '[Note from Mirg, not the user: your last reply was cut off because it ran past the output limit per reply' + limit + '. ' + saved + '\n\n' +
    'Carry on with the same task in a smaller step: think briefly, and write at most about ' + linesFor(tokens) + ' lines of code in your next reply. ' +
    'Finish a long file with append_file, starting exactly where it stopped, and do not rewrite what is already saved. Do not apologise or explain; just continue.]'
  )
}

async function postModel(path, body, signal, extra) {
  const t = await token()
  if (!t) throw Object.assign(new Error('Your session ended. Sign in again.'), { signin: true })
  const response = await fetch(API + '/proxy/' + path, {
    method: 'POST',
    signal,
    headers: Object.assign({ authorization: 'Bearer ' + t, 'x-mirg-device': device(), 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, extra || {}),
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const err = (Array.isArray(data) ? data[0] && data[0].error : data && data.error) || {}
    const message = err.message || 'The model request failed (' + response.status + ').'
    throw Object.assign(new Error(message), { code: err.type || err.code, status: response.status, param: err.param })
  }
  return response
}

/** Server-sent events, one parsed JSON object at a time. */
async function* events(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let cut
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n')
      if (!data || data === '[DONE]') continue
      try {
        yield JSON.parse(data)
      } catch (e) {}
    }
  }
}

/** Text files attached to a message travel inside it, so any model can read them. */
function withFiles(text, files) {
  const docs = files.filter((f) => f.kind === 'text')
  if (!docs.length) return text
  return text + docs.map((f) => '\n\n<attached_file name="' + f.name.replace(/"/g, '') + '">\n' + f.text + '\n</attached_file>').join('')
}

const ADAPTERS = {
  anthropic: {
    addUser(messages, text, files) {
      const content = files
        .filter((f) => f.kind === 'image')
        .map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }))
        .concat([{ type: 'text', text: withFiles(text, files) }])
      const prev = messages[messages.length - 1]
      // After an error or Stop the history can end on the user's side: carry on in the same turn.
      if (prev && prev.role === 'user') {
        messages[messages.length - 1] = { role: 'user', content: (typeof prev.content === 'string' ? [{ type: 'text', text: prev.content }] : prev.content).concat(content) }
        return messages.length - 1
      }
      messages.push({ role: 'user', content })
      return messages.length - 1
    },
    addResults(messages, results) {
      messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.call.id, content: r.content, is_error: r.isError || undefined })) })
    },
    async turn(model, messages, signal, ui, opts) {
      const body = {
        model,
        max_tokens: 12000,
        stream: true,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages: withCache(messages)
      }
      if (hasEffort(model)) {
        body.thinking = { type: 'adaptive', display: 'summarized' }
        body.output_config = { effort: opts.effort || settings.effort }
      }
      if (opts.noTools) body.tool_choice = { type: 'none' }
      // As in the app: if a safety check declines a request, the API retries it on its recommended model.
      const fallback = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-fable-5-1'].includes(model)
      if (fallback) body.fallbacks = 'default'
      const response = await postModel('anthropic/v1/messages?beta=true', body, signal, fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : null)
      const blocks = []
      let stop = null
      const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }
      for await (const ev of events(response)) {
        if (ev.type === 'message_start' && ev.message && ev.message.usage) {
          const u = ev.message.usage
          Object.assign(usage, { input: u.input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 })
        } else if (ev.type === 'content_block_start') {
          const b = Object.assign({}, ev.content_block)
          if (b.type === 'tool_use') b.json = ''
          if (b.type === 'text') b.text = b.text || ''
          if (b.type === 'thinking') b.thinking = b.thinking || ''
          blocks[ev.index] = b
          ui.start(b)
        } else if (ev.type === 'content_block_delta') {
          const b = blocks[ev.index]
          const d = ev.delta
          if (!b) continue
          if (d.type === 'text_delta') b.text += d.text
          else if (d.type === 'thinking_delta') b.thinking += d.thinking
          else if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature
          else if (d.type === 'input_json_delta') b.json += d.partial_json
          ui.delta(b)
        } else if (ev.type === 'content_block_stop') {
          const b = blocks[ev.index]
          if (!b) continue
          if (b.type === 'tool_use') {
            b.raw = b.json
            try {
              b.input = b.json ? JSON.parse(b.json) : {}
            } catch (e) {
              b.input = {}
            }
            delete b.json
          }
          ui.stop(b)
        } else if (ev.type === 'message_delta') {
          if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason
          if (ev.usage && ev.usage.output_tokens) usage.output = ev.usage.output_tokens
        } else if (ev.type === 'error') {
          throw new Error((ev.error && ev.error.message) || 'The model stopped with an error.')
        }
      }
      const all = blocks.filter(Boolean)
      const text = all
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      const result = { billed: usage.input + usage.cacheWrite + usage.output, context: usage.input + usage.cacheWrite + usage.cacheRead, output: usage.output, text, calls: [] }
      if (stop === 'max_tokens') {
        const cut = all.filter((b) => b.type === 'tool_use')
        return Object.assign(result, { stop: 'cut', cutIds: cut.map((b) => b.id), cutCalls: cut.map((b) => ({ id: b.id, name: b.name, raw: b.raw != null ? b.raw : b.json || '' })) })
      }
      const content = []
      for (const b of all) {
        if (b.type === 'text') {
          if (b.text && b.text.trim()) content.push({ type: 'text', text: b.text })
        } else if (b.type === 'thinking') content.push({ type: 'thinking', thinking: b.thinking || '', signature: b.signature || '' })
        else if (b.type === 'redacted_thinking') content.push({ type: 'redacted_thinking', data: b.data })
        else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input || {} })
      }
      if (!content.length) content.push({ type: 'text', text: '(no reply)' })
      if (!opts.dryRun) messages.push({ role: 'assistant', content })
      result.calls = content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }))
      result.stop = stop === 'refusal' ? 'refusal' : stop === 'tool_use' && result.calls.length ? 'tools' : 'end'
      return result
    }
  },

  openai: {
    addUser(messages, text, files) {
      const images = files.filter((f) => f.kind === 'image')
      const words = withFiles(text, files)
      messages.push({
        role: 'user',
        content: images.length ? images.map((i) => ({ type: 'input_image', image_url: 'data:' + i.mediaType + ';base64,' + i.data, detail: 'auto' })).concat([{ type: 'input_text', text: words }]) : words
      })
      return messages.length - 1
    },
    addResults(messages, results) {
      for (const r of results) messages.push({ type: 'function_call_output', call_id: r.call.id, output: r.isError ? 'ERROR: ' + r.content : r.content })
    },
    summaries: true,
    async turn(model, messages, signal, ui, opts) {
      const body = {
        model,
        instructions: SYSTEM,
        input: messages,
        tools: TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false })),
        reasoning: Object.assign({ effort: opts.effort || settings.effort }, this.summaries ? { summary: 'auto' } : {}),
        store: false,
        include: ['reasoning.encrypted_content'],
        stream: true
      }
      if (opts.noTools) body.tool_choice = 'none'
      let response
      try {
        response = await postModel('openai/v1/responses', body, signal)
      } catch (e) {
        // Some accounts may not ask for reasoning summaries: try once more without them.
        if (this.summaries && e.status === 400 && /reasoning|summary/i.test(String(e.param || '') + e.message)) {
          this.summaries = false
          return this.turn(model, messages, signal, ui, opts)
        }
        throw e
      }
      const live = new Map()
      const blockFor = (key, type) => {
        if (!live.has(key)) {
          const b = type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' }
          live.set(key, b)
          ui.start(b)
        }
        return live.get(key)
      }
      let final = null
      for await (const ev of events(response)) {
        if (ev.type === 'response.output_text.delta') {
          const b = blockFor('t' + ev.item_id, 'text')
          b.text += ev.delta || ''
          ui.delta(b)
        } else if (ev.type === 'response.reasoning_summary_text.delta') {
          const b = blockFor('r' + ev.item_id, 'thinking')
          b.thinking += ev.delta || ''
          ui.delta(b)
        } else if (ev.type === 'response.output_item.added' && ev.item && ev.item.type === 'function_call') {
          ui.start({ type: 'tool_use', id: ev.item.call_id, name: ev.item.name })
        } else if (ev.type === 'response.output_item.done' && ev.item && ev.item.type === 'reasoning') {
          const b = live.get('r' + ev.item.id)
          if (b) ui.stop(b)
        } else if (ev.type === 'response.completed' || ev.type === 'response.incomplete' || ev.type === 'response.failed') {
          final = ev.response
        } else if (ev.type === 'error') {
          throw new Error(ev.message || (ev.error && ev.error.message) || 'The model stopped with an error.')
        }
      }
      for (const b of live.values()) if (b.type === 'thinking') ui.stop(b)
      if (!final) throw new Error('The reply from GPT ended early. Send again.')
      if (final.status === 'failed') throw new Error('GPT could not complete the response: ' + ((final.error && final.error.message) || 'unknown error'))
      const u = final.usage || {}
      const cached = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0
      const output = final.output || []
      const text = output
        .filter((o) => o.type === 'message')
        .flatMap((o) => (o.content || []).filter((p) => p.type === 'output_text').map((p) => p.text))
        .join('\n')
      const calls = output.filter((o) => o.type === 'function_call').map((o) => {
        let input = {}
        try {
          input = JSON.parse(o.arguments || '{}')
        } catch (e) {}
        return { id: o.call_id, name: o.name, input }
      })
      const result = { billed: (u.total_tokens || 0) - cached, context: u.input_tokens || 0, output: u.output_tokens || 0, text, calls }
      if (final.status === 'incomplete') {
        const reason = final.incomplete_details && final.incomplete_details.reason
        const cutCalls = output.filter((o) => o.type === 'function_call').map((o) => ({ id: o.call_id, name: o.name, raw: o.arguments || '' }))
        return Object.assign(result, { calls: [], stop: reason === 'content_filter' ? 'refusal' : 'cut', cutIds: calls.map((c) => c.id), cutCalls })
      }
      // Everything the model produced (reasoning, text, calls) goes back unchanged next turn.
      if (!opts.dryRun) messages.push(...output)
      result.stop = calls.length ? 'tools' : 'end'
      return result
    }
  },

  gemini: {
    addUser(messages, text, files) {
      const parts = files
        .filter((f) => f.kind === 'image')
        .map((i) => ({ inlineData: { mimeType: i.mediaType, data: i.data } }))
        .concat([{ text: withFiles(text, files) }])
      const prev = messages[messages.length - 1]
      if (prev && prev.role === 'user') {
        prev.parts = prev.parts.concat(parts)
        return messages.length - 1
      }
      messages.push({ role: 'user', parts })
      return messages.length - 1
    },
    addResults(messages, results) {
      messages.push({
        role: 'user',
        parts: results.map((r) => ({ functionResponse: Object.assign(r.call.gid ? { id: r.call.gid } : {}, { name: r.call.name, response: r.isError ? { error: r.content } : { output: r.content } }) }))
      })
    },
    async turn(model, messages, signal, ui, opts) {
      const body = {
        contents: messages,
        systemInstruction: { parts: [{ text: SYSTEM }] },
        tools: [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }],
        generationConfig: { thinkingConfig: Object.assign({ includeThoughts: true }, hasEffort(model) ? { thinkingLevel: (opts.effort || settings.effort).toUpperCase() } : {}) }
      }
      if (opts.noTools) body.toolConfig = { functionCallingConfig: { mode: 'NONE' } }
      const path = 'gemini/v1beta/models/' + model + ':streamGenerateContent?alt=sse'
      for (let attempt = 0; ; attempt++) {
        const parts = []
        const calls = []
        let finish = null
        let usage = {}
        let textBlock = null
        let thought = null
        try {
          const response = await postModel(path, body, signal)
          for await (const chunk of events(response)) {
            const candidate = chunk.candidates && chunk.candidates[0]
            for (const part of (candidate && candidate.content && candidate.content.parts) || []) {
              parts.push(part)
              if (part.functionCall && part.functionCall.name) {
                const call = { id: 'call_' + newId(), gid: part.functionCall.id, name: part.functionCall.name, input: part.functionCall.args || {} }
                calls.push(call)
                ui.start({ type: 'tool_use', id: call.id, name: call.name })
              } else if (part.text) {
                if (part.thought) {
                  if (!thought) ui.start((thought = { type: 'thinking', thinking: '' }))
                  thought.thinking += part.text
                  ui.delta(thought)
                } else {
                  if (thought) ui.stop(thought)
                  if (!textBlock) ui.start((textBlock = { type: 'text', text: '' }))
                  textBlock.text += part.text
                  ui.delta(textBlock)
                }
              }
            }
            if (candidate && candidate.finishReason) finish = candidate.finishReason
            if (chunk.usageMetadata) usage = chunk.usageMetadata
            if (chunk.error) throw new Error(chunk.error.message || 'Gemini stopped with an error.')
          }
        } catch (e) {
          // Google's "busy" and rate-limit answers are worth a couple of quiet retries, if nothing was shown yet.
          if (!signal.aborted && !parts.length && [429, 500, 502, 503, 504].includes(e.status) && attempt < 2) {
            await sleep(e.status === 429 ? 15000 : 3000)
            continue
          }
          if ([500, 502, 503, 504].includes(e.status)) throw new Error("Google's Gemini is overloaded right now. Wait a minute and send again, or pick another model.")
          throw e
        }
        if (thought) ui.stop(thought)
        const result = { billed: (usage.totalTokenCount || 0) - (usage.cachedContentTokenCount || 0), context: usage.promptTokenCount || 0, output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0), text: textBlock ? textBlock.text : '', calls }
        // Gemini only sends a call once it is whole, so every call here is complete.
        if (finish === 'MAX_TOKENS') return Object.assign(result, { calls: [], stop: 'cut', cutIds: calls.map((c) => c.id), cutCalls: calls.map((c) => ({ id: c.id, name: c.name, raw: JSON.stringify(c.input || {}) })) })
        if (!parts.length) throw new Error('Gemini returned nothing' + (finish && finish !== 'STOP' ? ' (' + finish + ')' : '') + '. Try rephrasing, or pick another model.')
        // Parts go back exactly as received: thought signatures ride on them.
        if (!opts.dryRun) messages.push({ role: 'model', parts })
        result.stop = /SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(finish || '') ? 'refusal' : calls.length ? 'tools' : 'end'
        return result
      }
    }
  }
}

/** Copies messages and marks the last block, so the conversation so far is re-read from cache. */
function withCache(messages) {
  const out = messages.slice()
  const last = out[out.length - 1]
  if (!last) return out
  const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.map((b) => Object.assign({}, b))
  content[content.length - 1] = Object.assign({}, content[content.length - 1], { cache_control: { type: 'ephemeral' } })
  out[out.length - 1] = { role: last.role, content }
  return out
}

const quietUi = { start() {}, delta() {}, stop() {} }

/** When the conversation has grown long, replace it with a summary written by the model. */
async function compact(c, signal) {
  if ((c.contextTokens || 0) < COMPACT_AT || !c.messages.length) return ''
  const notice = addItem({ kind: 'notice', text: 'Summarizing earlier messages to keep the conversation fast…' })
  const adapter = ADAPTERS[c.provider]
  const messages = JSON.parse(JSON.stringify(c.messages))
  adapter.addUser(messages, SUMMARY_REQUEST, [])
  const { text } = await adapter.turn(currentModel(), messages, signal, quietUi, { noTools: true, dryRun: true })
  const summary = (text || '').trim()
  if (!summary) {
    notice.text = 'Could not summarize the earlier messages; carrying on.'
    refresh(notice)
    return ''
  }
  c.messages = []
  c.contextTokens = 0
  // Restore needs the conversation as it was, which is gone now.
  for (const item of c.items) if (item.kind === 'user') delete item.mark
  notice.text = 'Earlier messages were summarized to keep the conversation fast.'
  refresh(notice)
  return 'This conversation grew long, so everything before this point was replaced by the summary below.\n\n<summary>\n' + summary + "\n</summary>\n\nCarry on from where the summary leaves off. The user's most recent message is:\n\n"
}

/** A chat continued with another vendor's model: it starts afresh with the gist of what was said. */
function recapOf(c) {
  const lines = []
  for (const item of c.items) {
    if (item.kind === 'user') lines.push('User: ' + item.text.slice(0, 600))
    else if (item.kind === 'agent') lines.push('You: ' + item.text.slice(0, 600))
  }
  let body = lines.join('\n\n')
  if (body.length > 8000) body = '…' + body.slice(-8000)
  return (
    'This chat was carried on from a different AI model, so here is a recap of it instead of the full conversation.\n\n<recap>\n' +
    body +
    '\n</recap>\n\nThe game already has these files: ' +
    (Object.keys(project.files).sort().join(', ') || 'none') +
    ". Read them before changing them. The user's new message is:\n\n"
  )
}

async function agent(text, files) {
  if (running || !project) return
  files = files || []
  const c = chat()
  const controller = new AbortController()
  running = controller
  startedAt = Date.now()
  lastRestore = null
  $('restored').hidden = true
  setRunning(true)
  let changed = false
  let userItem = null
  let pendingMark = null
  const toolItems = new Map()
  try {
    const model = currentModel()
    const provider = providerOf(model)
    let recap = ''
    if (!c.provider) c.provider = provider
    if (c.provider !== provider) {
      if (c.messages.length) {
        recap = recapOf(c)
        c.messages = []
        c.contextTokens = 0
        for (const item of c.items) if (item.kind === 'user') delete item.mark
        addItem({ kind: 'notice', text: 'Carrying on with ' + PROVIDER_NAMES[provider] + ': it gets a recap of this chat.' })
      }
      c.provider = provider
    }
    const adapter = ADAPTERS[provider]
    if (!recap) recap = await compact(c, controller.signal)
    let note = ''
    if (!c.messages.length && !recap && Object.keys(project.files).length) note = '\n\n(The project already has these files: ' + Object.keys(project.files).sort().join(', ') + '.)'
    // Older snapshots are dropped so a long session does not fill the browser's storage.
    const turns = c.items.filter((i) => i.kind === 'user' && i.before)
    for (const old of turns.slice(0, Math.max(0, turns.length - 24))) delete old.before
    userItem = addItem({
      kind: 'user',
      text,
      pics: files.filter((f) => f.kind === 'image').map((i) => i.thumb),
      docs: files.filter((f) => f.kind === 'text').map((f) => f.name),
      before: JSON.parse(JSON.stringify(project.files)),
      mark: c.messages.length,
      tokens: 0,
      ms: 0
    })
    if (!c.title || c.title === 'New chat') {
      c.title = text.replace(/\s+/g, ' ').slice(0, 60) || 'Chat'
      renderChatName()
    }
    const at = adapter.addUser(c.messages, recap + text + note + deviceNote(), files)
    // Restore cuts the history back to just before this message.
    userItem.mark = Math.min(userItem.mark, at)
    save()
    // Replies cut off for length in a row; after one, the rest of this turn thinks at low effort.
    let cuts = 0
    let squeezed = false
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const live = new Map()
      const working = addWorking()
      const ui = {
        start(b) {
          working.remove()
          let item = null
          if (b.type === 'text') item = addItem({ kind: 'agent', text: '' })
          else if (b.type === 'thinking') item = addItem({ kind: 'thinking', text: '', live: true, t0: Date.now() })
          else if (b.type === 'tool_use') {
            item = addItem({ kind: 'tool', title: toolLabel(b.name) + '…', running: true, t0: Date.now() })
            toolItems.set(b.id, item)
          }
          if (item) live.set(b, item)
        },
        delta(b) {
          const item = live.get(b)
          if (!item) return
          if (b.type === 'text') item.text = b.text
          else if (b.type === 'thinking') item.text = b.thinking
          else return
          refresh(item)
        },
        stop(b) {
          const item = live.get(b)
          if (item && b.type === 'thinking' && item.live) {
            item.live = false
            item.ms = Date.now() - item.t0
            refresh(item)
          }
        }
      }
      const before = c.messages.length
      let result
      try {
        result = await adapter.turn(model, c.messages, controller.signal, ui, squeezed ? { effort: 'low' } : {})
      } finally {
        working.remove()
      }
      userItem.tokens += result.billed
      c.contextTokens = result.context
      // Text that came to nothing leaves no empty bubble behind.
      for (const [b, item] of live) if (b.type === 'text' && !b.text.trim()) removeItem(item)
      if (result.stop === 'cut') {
        cuts++
        // Keep what the cut-off reply had done, so the next reply carries on instead of starting over.
        const kept = await salvage(result.cutCalls || [])
        for (const k of kept) {
          const item = toolItems.get(k.id)
          if (item) Object.assign(item, { running: false, bad: false, title: k.title, detail: k.detail })
          changed = true
        }
        // A step that was cut off and kept nothing is not shown: the next reply simply carries on,
        // and a red "cut off" line made people think the builder was broken.
        const keptIds = new Set(kept.map((k) => k.id))
        for (const id of result.cutIds || []) {
          const item = toolItems.get(id)
          if (item && !keptIds.has(id)) {
            removeItem(item)
            toolItems.delete(id)
          }
        }
        toolItems.forEach(refresh)
        adapter.addUser(c.messages, cutNote(kept, result.output), [])
        save()
        // Thinking counts toward the limit, so the next replies think less and write smaller steps.
        squeezed = true
        // A second cut in a row would likely be followed by a third: stop rather than spend more.
        if (cuts >= 2) {
          addItem({ kind: 'notice', text: 'Mirg paused here to save your building time. Everything so far is saved. Send "keep going" to carry on.' })
          break
        }
        continue
      }
      cuts = 0
      save()
      if (result.stop !== 'tools') {
        if (result.stop === 'refusal') addItem({ kind: 'error', text: 'The model declined this request. Try describing the game differently.' })
        break
      }
      // The model's tool calls are now in the history; they need answers before anything else is sent.
      pendingMark = before
      const results = []
      for (const call of result.calls) {
        if (controller.signal.aborted) break
        const item = toolItems.get(call.id) || addItem({ kind: 'tool', title: toolLabel(call.name) + '…', running: true, t0: Date.now() })
        const t0 = Date.now()
        let out
        let isError = false
        try {
          const r = await runTool(call.name, call.input || {})
          out = r.text
          Object.assign(item, { title: r.title, detail: r.detail, bad: Boolean(r.bad) })
          if (r.changed) changed = true
          if (r.ran) changed = false
        } catch (e) {
          out = e.message
          isError = true
          Object.assign(item, { title: toolLabel(call.name) + ': failed', detail: e.detail || e.message, bad: true })
        }
        item.running = false
        item.ms = Date.now() - t0
        refresh(item)
        results.push({ call, content: String(out).slice(0, 30000), isError })
      }
      // Every tool call needs an answer, even when the user pressed Stop part way through.
      for (const call of result.calls) if (!results.some((r) => r.call === call)) results.push({ call, content: 'Stopped by the user.', isError: true })
      adapter.addResults(c.messages, results)
      pendingMark = null
      save()
      if (controller.signal.aborted) break
      if (round === MAX_ROUNDS - 1) addItem({ kind: 'notice', text: 'Paused after many steps. Send "keep going" to continue.' })
    }
  } catch (e) {
    if (e.name === 'AbortError' || controller.signal.aborted) addItem({ kind: 'notice', text: 'Stopped.' })
    else {
      const limit = e.code === 'mirg_limit' || e.code === 'mirg_device' || e.code === 'mirg_capacity'
      const shown = addItem({ kind: 'error', text: e.message, limit })
      // Counted once, when the message first appears (not again when a saved chat is reopened).
      if (limit && isFreeLimit(e.message)) {
        call('POST', '/track', { kind: 'limit_seen' }).catch(() => undefined)
        // The plan as it is now, for the time the free building time is back.
        refreshMe().then(() => refresh(shown)).catch(() => undefined)
      }
      if (e.signin) signIn().catch(() => undefined)
      queuePaused = queue.length > 0
    }
    // Tool calls that never got answers are dropped; the user's message stays last, a valid place to carry on from.
    if (pendingMark !== null) c.messages.length = pendingMark
  } finally {
    for (const item of toolItems.values())
      if (item.running) {
        Object.assign(item, { running: false, bad: true, title: item.title.replace(/…$/, '') + ': stopped' })
        refresh(item)
      }
    if (userItem) {
      userItem.ms = Date.now() - startedAt
      refresh(userItem)
    }
    if (controller.signal.aborted) queuePaused = queue.length > 0
    c.updated = Date.now()
    running = null
    setRunning(false)
    save()
    if (changed || !frame) runGame()
    refreshMe()
    nextQueued()
  }
}

function nextQueued() {
  renderQueue()
  if (running || queuePaused || !queue.length) return
  const next = queue.shift()
  renderQueue()
  agent(next.text, next.files)
}

let ticker = null
function setRunning(on) {
  $('send').textContent = on ? 'Queue' : 'Send'
  $('send').title = on ? 'Sends when the agent finishes' : ''
  $('stop').hidden = !on
  $('elapsed').hidden = !on
  $('input').placeholder = on ? 'Mirg is working. Type to queue your next message…' : 'Ask for a change: a double jump, a boss, more enemies…'
  $('new-chat').disabled = on
  $('source').readOnly = on
  clearInterval(ticker)
  if (on) {
    const tick = () => ($('elapsed').textContent = duration(Date.now() - startedAt))
    tick()
    ticker = setInterval(tick, 1000)
  }
  document.querySelectorAll('[data-restore]').forEach((b) => (b.hidden = on))
}

window.addEventListener('beforeunload', (e) => {
  if (running || dirty) {
    e.preventDefault()
    e.returnValue = ''
  }
})

// ---------------------------------------------------------------------------------------------
// Chat display. Each item is drawn once and redrawn in place when it changes.

function duration(ms) {
  const s = Math.round(ms / 1000)
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'
}

function tokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n)
}

function markdown(text) {
  const inline = (s) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  const out = []
  let list = null
  let fence = null
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (fence) {
        out.push('<pre><code>' + escapeHtml(fence.join('\n')) + '</code></pre>')
        fence = null
      } else fence = []
      list = null
      continue
    }
    if (fence) {
      fence.push(line)
      continue
    }
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line)
    if (item) {
      if (!list) {
        list = []
        out.push(list)
      }
      list.push('<li>' + inline(item[1]) + '</li>')
      continue
    }
    list = null
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) out.push('<p><strong>' + inline(h[1]) + '</strong></p>')
    else if (line.trim()) out.push('<p>' + inline(line) + '</p>')
  }
  if (fence) out.push('<pre><code>' + escapeHtml(fence.join('\n')) + '</code></pre>')
  return out.map((x) => (Array.isArray(x) ? '<ul>' + x.join('') + '</ul>' : x)).join('')
}

const drawn = new WeakMap()
const openFolds = new WeakSet()
let stick = true
$('log').addEventListener('scroll', () => {
  const log = $('log')
  stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80
})

function scrollLog(force) {
  const log = $('log')
  if (force || stick) log.scrollTop = log.scrollHeight
}

function fold(item, cls, head, body) {
  const el = document.createElement('div')
  el.className = 'fold ' + cls + (item.bad ? ' bad' : '') + (openFolds.has(item) ? ' open' : '')
  const button = document.createElement('button')
  button.type = 'button'
  button.innerHTML = head
  el.appendChild(button)
  if (body) {
    button.insertAdjacentHTML('beforeend', ' <svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>')
    if (openFolds.has(item)) {
      const b = document.createElement('div')
      b.className = 'body'
      b.textContent = body
      el.appendChild(b)
    }
    button.onclick = () => {
      openFolds.has(item) ? openFolds.delete(item) : openFolds.add(item)
      refresh(item)
    }
  }
  return el
}

function draw(item) {
  let el
  if (item.kind === 'user') {
    el = document.createElement('div')
    el.className = 'turn'
    const bubble = document.createElement('div')
    bubble.className = 'msg user'
    if (item.pics && item.pics.length) {
      const pics = document.createElement('div')
      pics.className = 'pics'
      for (const src of item.pics) {
        const img = document.createElement('img')
        img.src = src
        img.alt = 'Attached picture'
        pics.appendChild(img)
      }
      bubble.appendChild(pics)
    }
    if (item.docs && item.docs.length) {
      const docs = document.createElement('div')
      docs.className = 'pics'
      for (const name of item.docs) {
        const d = document.createElement('span')
        d.className = 'doc'
        d.textContent = name
        docs.appendChild(d)
      }
      bubble.appendChild(docs)
    }
    bubble.appendChild(document.createTextNode(item.text))
    el.appendChild(bubble)
    const meta = document.createElement('div')
    meta.className = 'meta'
    const facts = [item.tokens ? tokens(item.tokens) + ' tokens' : '', item.ms >= 1000 ? duration(item.ms) : ''].filter(Boolean).join(' · ')
    if (facts) {
      const span = document.createElement('span')
      span.textContent = facts
      span.title = 'Tokens billed at full price (new input and output; re-reading the conversation is not counted) and how long the agent worked on this message'
      meta.appendChild(span)
    }
    if (item.before && item.mark !== undefined) {
      const b = document.createElement('button')
      b.type = 'button'
      b.dataset.restore = '1'
      b.hidden = Boolean(running)
      b.textContent = '↺ Restore'
      b.title = 'Put the game back to how it was before this message. Everything built since is removed (you can undo this).'
      b.onclick = () => {
        if (b.dataset.armed) return restore(item)
        b.dataset.armed = '1'
        b.classList.add('confirm')
        b.textContent = 'Remove everything since this message?'
      }
      b.onblur = () => {
        delete b.dataset.armed
        b.classList.remove('confirm')
        b.textContent = '↺ Restore'
      }
      meta.appendChild(b)
    }
    el.appendChild(meta)
  } else if (item.kind === 'agent') {
    el = document.createElement('div')
    el.className = 'msg agent'
    el.innerHTML = markdown(item.text)
  } else if (item.kind === 'thinking') {
    const head = item.live ? '<span class="mark"><span class="spinner"></span></span>Thinking…' : '<span class="mark">✦</span>Thought' + (item.ms >= 1000 ? ' for ' + duration(item.ms) : '')
    el = fold(item, 'thinking', head, item.text.trim())
  } else if (item.kind === 'tool') {
    const mark = item.running ? '<span class="spinner"></span>' : item.bad ? '!' : '✓'
    const when = !item.running && item.ms >= 1000 ? ' <span class="when">' + duration(item.ms) + '</span>' : ''
    el = fold(item, 'tool', '<span class="mark">' + mark + '</span><span>' + escapeHtml(item.title) + '</span>' + when, item.detail)
  } else if (item.kind === 'error') {
    el = document.createElement('div')
    el.className = 'msg error'
    el.textContent = item.text
    if (item.limit && isFreeLimit(item.text)) el.appendChild(freeLimitActions(item.text))
    else if (item.limit) {
      // Settings has the Pro and Max buttons; the game and chat stay as they are.
      const a = document.createElement('a')
      a.href = '#settings'
      a.textContent = ' Upgrade'
      el.appendChild(a)
    }
  } else {
    el = document.createElement('div')
    el.className = 'msg notice'
    el.textContent = item.text
  }
  drawn.set(item, el)
  return el
}

// The free plan's limit message ("…free plan's building time… Upgrade to Pro…") gets its own buttons:
// Pro straight to checkout, an email when the free time is back (only while it is coming back), and
// the plans in Settings. Paid plans never see this message.
// The out-of-building-time message, on any plan: it offers credits (and Pro, on the free plan).
function isFreeLimit(text) {
  return (/free plan's (building time|usage)/i.test(text) && /upgrade/i.test(text)) || /add credits/i.test(text)
}

// Credits, bought once: what each amount buys, from what /me says ($20 buys $14).
const CREDIT_AMOUNTS = [5, 10, 20, 50]
function creditsLabel(dollars) {
  const ratio = (me && me.credits && me.credits.ratio) || 0.7
  const usage = dollars * ratio
  return '$' + dollars + ' (' + (Number.isInteger(usage) ? '$' + usage : '$' + usage.toFixed(2)) + ' of building)'
}
// Opens Stripe's page for credits in a new tab. `tab` was opened during the click, so it is not blocked.
async function buyCredits(dollars, tab) {
  call('POST', '/track', { kind: 'upgrade_click' }).catch(() => undefined)
  try {
    const { url } = await call('POST', '/billing/credits?amount=' + dollars)
    if (!/^https:\/\//.test(url)) throw new Error('The checkout page address was not valid.')
    if (tab) tab.location.href = url
    else location.href = url
  } catch (e) {
    if (tab) tab.close()
    throw e
  }
}

function freeLimitActions(text) {
  const box = document.createElement('div')
  box.className = 'limit-actions'
  const row = document.createElement('div')
  row.className = 'limit-buttons'
  const note = document.createElement('div')
  note.className = 'limit-note'
  note.hidden = true
  const say = (message) => {
    note.textContent = message
    note.hidden = !message
  }
  const buttons = []
  const busy = (on) => buttons.forEach((b) => (b.disabled = on || b.dataset.done === '1'))
  const button = (label, cls, onclick) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = cls
    b.textContent = label
    b.onclick = onclick
    buttons.push(b)
    row.appendChild(b)
    return b
  }
  // When the free time is back, as a time of day on this computer.
  const back = /comes back in/i.test(text) && me && me.periodEnd && Date.parse(me.periodEnd) > Date.now() ? new Date(me.periodEnd) : null
  if (back) {
    const when = document.createElement('div')
    when.className = 'limit-when'
    when.textContent = 'Your free building time is back at ' + back.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '.'
    box.appendChild(when)
  }
  // Credits: pick an amount, pay once. Shown on every plan.
  const amounts = document.createElement('div')
  amounts.className = 'limit-amounts'
  amounts.hidden = true
  for (const dollars of CREDIT_AMOUNTS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'btn small'
    b.textContent = creditsLabel(dollars)
    b.onclick = async () => {
      const tab = window.open('', '_blank')
      busy(true)
      say('')
      try {
        await buyCredits(dollars, tab)
        say('Checkout opened in a new tab. After paying, come back here: your credits show within a minute.')
      } catch (e) {
        say(e.message)
      } finally {
        busy(false)
      }
    }
    buttons.push(b)
    amounts.appendChild(b)
  }
  const credits = button('Add credits', 'btn small' + (me && me.plan !== 'free' ? ' primary' : ''), () => {
    amounts.hidden = !amounts.hidden
    credits.setAttribute('aria-expanded', String(!amounts.hidden))
  })
  credits.setAttribute('aria-expanded', 'false')
  if (me && me.plan !== 'free') {
    const compare = document.createElement('a')
    compare.href = '#settings'
    compare.className = 'limit-link'
    compare.textContent = 'Plans and billing'
    row.appendChild(compare)
    box.append(row, amounts, note)
    return box
  }
  button('Upgrade to Pro, $20/month (better deal)', 'btn small primary', async () => {
    call('POST', '/track', { kind: 'upgrade_click' }).catch(() => undefined)
    // Opened now, while the click still counts, so the browser does not block it as a pop-up.
    const tab = window.open('', '_blank')
    busy(true)
    say('')
    try {
      const { url } = await call('POST', '/billing/checkout?plan=pro')
      if (!/^https:\/\//.test(url)) throw new Error('The checkout page address was not valid.')
      if (tab) tab.location.href = url
      else location.href = url
      say('Checkout opened in a new tab. After paying, come back here: your plan updates within a minute.')
    } catch (e) {
      if (tab) tab.close()
      say(e.message)
    } finally {
      busy(false)
    }
  })
  if (/comes back in/i.test(text)) {
    const remind = button("Email me when it's back", 'btn small', async () => {
      busy(true)
      say('')
      try {
        const { at, email } = await call('POST', '/remind')
        remind.dataset.done = '1'
        remind.textContent = "We'll email you"
        say("Done. We'll email " + email + ' at ' + new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + ', when your free time is back.')
      } catch (e) {
        say(e.message)
      } finally {
        busy(false)
      }
    })
  }
  const compare = document.createElement('a')
  compare.href = '#settings'
  compare.className = 'limit-link'
  compare.textContent = 'Compare plans'
  row.appendChild(compare)
  box.append(row, amounts, note)
  return box
}

const dirtyItems = new Set()
function refresh(item) {
  if (!drawn.has(item)) return
  dirtyItems.add(item)
  if (dirtyItems.size === 1)
    requestAnimationFrame(() => {
      for (const it of dirtyItems) {
        const old = drawn.get(it)
        if (old && old.parentNode) old.replaceWith(draw(it))
      }
      dirtyItems.clear()
      scrollLog()
    })
}

function addItem(item) {
  const c = chat()
  c.items.push(item)
  if (c.items.length > 600) c.items.splice(0, c.items.length - 600)
  const working = $('log').querySelector('.working')
  $('log').insertBefore(draw(item), working)
  scrollLog()
  return item
}

function removeItem(item) {
  const c = chat()
  const i = c.items.indexOf(item)
  if (i >= 0) c.items.splice(i, 1)
  const el = drawn.get(item)
  if (el) el.remove()
}

function addWorking() {
  const el = document.createElement('div')
  el.className = 'working'
  el.innerHTML = '<span class="spinner"></span> Working…'
  $('log').appendChild(el)
  scrollLog()
  return el
}

function renderChat() {
  const c = chat()
  $('log').innerHTML = ''
  for (const item of c.items) {
    // Anything left mid-way by a closed tab is finished now.
    if (item.live || item.running) Object.assign(item, { live: false, running: false })
    $('log').appendChild(draw(item))
  }
  renderChatName()
  scrollLog(true)
}

function renderChatName() {
  $('chat-name').textContent = (project && chat().title) || 'New chat'
}

// ---------------------------------------------------------------------------------------------
// Chats: several per game, like the app.

function newChat() {
  if (running || !project) return
  const c = chat()
  if (c && !c.messages.length && !c.items.length) return
  const fresh = { id: newId(), title: 'New chat', messages: [], items: [], updated: Date.now(), contextTokens: 0 }
  project.chats.push(fresh)
  project.chatId = fresh.id
  save()
  renderChat()
  $('input').focus()
}

function when(time) {
  const minutes = Math.round((Date.now() - time) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return minutes + 'm ago'
  if (minutes < 60 * 24) return Math.round(minutes / 60) + 'h ago'
  return new Date(time).toLocaleDateString()
}

function renderChatMenu() {
  const menu = $('chat-menu')
  menu.innerHTML = '<div class="label">Chats about this game</div>'
  for (const c of project.chats.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0))) {
    const row = document.createElement('div')
    row.className = 'row' + (c.id === project.chatId ? ' on' : '')
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'open'
    open.innerHTML = '<span></span><span></span>'
    open.firstChild.textContent = c.title || 'New chat'
    open.lastChild.textContent = when(c.updated || project.updated)
    open.onclick = () => {
      menu.hidden = true
      if (running || c.id === project.chatId) return
      project.chatId = c.id
      save()
      renderChat()
    }
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'icon-btn'
    del.textContent = '✕'
    del.title = 'Delete this chat (the game stays as it is)'
    del.onclick = () => {
      if (running || !confirm('Delete the chat "' + (c.title || 'New chat') + '"? The game stays as it is.')) return
      project.chats = project.chats.filter((x) => x.id !== c.id)
      if (!project.chats.length) project.chats.push({ id: newId(), title: 'New chat', messages: [], items: [], updated: Date.now(), contextTokens: 0 })
      if (project.chatId === c.id) {
        project.chatId = project.chats[0].id
        renderChat()
      }
      save()
      renderChatMenu()
    }
    row.append(open, del)
    menu.appendChild(row)
  }
}

$('chat-title').onclick = (e) => {
  e.stopPropagation()
  const menu = $('chat-menu')
  if (menu.hidden) renderChatMenu()
  menu.hidden = !menu.hidden
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#chat-menu')) $('chat-menu').hidden = true
})
$('new-chat').onclick = newChat

// ---------------------------------------------------------------------------------------------
// Restore: put the game and the chat back to how they were before a message.

let lastRestore = null
function restore(item) {
  if (running) return
  const c = chat()
  const at = c.items.indexOf(item)
  if (at < 0 || !item.before || item.mark === undefined) return
  lastRestore = { chatId: c.id, files: project.files, messages: c.messages, items: c.items, contextTokens: c.contextTokens }
  project.files = JSON.parse(JSON.stringify(item.before))
  c.messages = c.messages.slice(0, item.mark)
  c.items = c.items.slice(0, at)
  c.contextTokens = 0
  $('input').value = item.text
  save()
  renderChat()
  renderFiles()
  runGame()
  $('restored').hidden = false
}

$('undo-restore').onclick = () => {
  if (!lastRestore || running) return
  const c = project.chats.find((x) => x.id === lastRestore.chatId)
  if (c) Object.assign(c, { messages: lastRestore.messages, items: lastRestore.items, contextTokens: lastRestore.contextTokens })
  project.files = lastRestore.files
  lastRestore = null
  $('input').value = ''
  $('restored').hidden = true
  save()
  renderChat()
  renderFiles()
  runGame()
}

// ---------------------------------------------------------------------------------------------
// Files attached to a message: pictures (a sketch of a level, a game to match) go to the model as
// images; text and code files go inside the message for it to read. Other files cannot be used
// by a browser game made of text files, so they are turned away with a reason.

let pendingFiles = []
const MAX_FILES_PER_MESSAGE = 6
const MAX_TEXT_FILE = 200_000
const TEXT_FILE = /\.(txt|md|markdown|js|mjs|cjs|ts|jsx|tsx|json|html|htm|css|csv|tsv|xml|svg|yaml|yml|toml|ini|glsl|frag|vert|lua|py|gd|cs|java|c|cpp|h|rb|go|rs|log)$/i

async function readPicture(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const draw = (max, quality) => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/jpeg', quality)
    }
    return { kind: 'image', name: file.name, mediaType: 'image/jpeg', data: draw(1568, 0.85).split(',')[1], thumb: draw(160, 0.7) }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function attach(list) {
  const refused = []
  for (const f of [...list]) {
    if (pendingFiles.length >= MAX_FILES_PER_MESSAGE) {
      refused.push('Up to ' + MAX_FILES_PER_MESSAGE + ' files per message.')
      break
    }
    try {
      if (/^image\/(png|jpeg|webp|gif)$/.test(f.type)) pendingFiles.push(await readPicture(f))
      else if (TEXT_FILE.test(f.name) || /^text\//.test(f.type) || f.type === 'application/json') {
        if (f.size > MAX_TEXT_FILE) refused.push(f.name + ' is too big (over 200 KB) to attach.')
        else pendingFiles.push({ kind: 'text', name: f.name, text: await f.text() })
      } else refused.push(f.name + " can't be attached: the web version takes pictures and text or code files. For sounds, 3D models and other files, use the Mirg desktop app.")
    } catch (e) {
      refused.push('Could not read ' + f.name + '.')
    }
  }
  renderPending()
  if (refused.length) toast(refused.join(' '))
}

function renderPending() {
  const box = $('pending')
  box.innerHTML = ''
  box.hidden = !pendingFiles.length
  pendingFiles.forEach((p, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'pic'
    let img
    if (p.kind === 'image') {
      img = document.createElement('img')
      img.src = p.thumb
      img.alt = 'Attached picture'
    } else {
      img = document.createElement('span')
      img.className = 'doc'
      img.textContent = p.name
      img.title = p.name
    }
    const x = document.createElement('button')
    x.type = 'button'
    x.textContent = '×'
    x.title = 'Remove'
    x.onclick = () => {
      pendingFiles.splice(i, 1)
      renderPending()
    }
    wrap.append(img, x)
    box.appendChild(wrap)
  })
}

$('attach').onclick = () => $('attach-input').click()
$('attach-input').onchange = (e) => {
  attach(e.target.files || [])
  e.target.value = ''
}
$('input').addEventListener('paste', (e) => {
  const files = [...((e.clipboardData && e.clipboardData.files) || [])]
  if (!files.length) return
  e.preventDefault()
  attach(files)
})
const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files')
$('chat').addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return
  e.preventDefault()
  $('chat').classList.add('dropping')
})
$('chat').addEventListener('dragleave', (e) => {
  if (!$('chat').contains(e.relatedTarget)) $('chat').classList.remove('dropping')
})
$('chat').addEventListener('drop', (e) => {
  if (!hasFiles(e)) return
  e.preventDefault()
  $('chat').classList.remove('dropping')
  attach(e.dataTransfer.files)
})

function renderQueue() {
  const box = $('queue')
  box.innerHTML = ''
  box.hidden = !queue.length
  if (!queue.length) {
    queuePaused = false
    return
  }
  const label = document.createElement('div')
  label.className = 'label'
  label.textContent = queuePaused ? 'Queue paused' : 'Next up (' + queue.length + ')'
  if (queuePaused && !running) {
    const resume = document.createElement('button')
    resume.type = 'button'
    resume.className = 'linklike'
    resume.textContent = ' Resume'
    resume.onclick = () => {
      queuePaused = false
      nextQueued()
    }
    label.appendChild(resume)
  }
  box.appendChild(label)
  queue.forEach((q, i) => {
    const row = document.createElement('div')
    row.className = 'item'
    const span = document.createElement('span')
    span.textContent = q.text || q.files.length + ' file(s)'
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'icon-btn'
    x.textContent = '✕'
    x.title = 'Remove from the queue'
    x.onclick = () => {
      queue.splice(i, 1)
      renderQueue()
    }
    row.append(span, x)
    box.appendChild(row)
  })
}

// ---------------------------------------------------------------------------------------------
// Voice input, like the app: the microphone streams to a live speech-to-text service and words
// appear in the box as they are recognized. Mirg's server hands out a one-use pass, and the
// seconds spoken are charged to the plan.

const VOICE_RATE = 16_000
const VOICE_MAX_MS = 110_000
let voice = null

const joinWords = (...parts) => parts.map((p) => p.trim()).filter(Boolean).join(' ')

function micState(button, state) {
  button.classList.toggle('recording', state === 'recording')
  button.disabled = state === 'starting' || state === 'working'
  const label = state === 'recording' ? 'Stop listening' : state === 'starting' ? 'Starting…' : state === 'working' ? 'Finishing…' : 'Speak your message'
  button.title = label
  button.setAttribute('aria-label', label)
  button.setAttribute('aria-pressed', String(state === 'recording'))
}

function voiceEnd(v) {
  if (voice === v) voice = null
  clearTimeout(v.limit)
  v.stream.getTracks().forEach((t) => t.stop())
  v.context.close().catch(() => undefined)
  const ws = v.socket
  if (ws) {
    ws.onmessage = ws.onclose = ws.onerror = null
    if (ws.readyState <= 1) ws.close()
  }
  const seconds = v.samples / VOICE_RATE
  if (seconds > 0) call('POST', '/voice/usage', { seconds }).catch(() => undefined)
  v.samples = 0
  micState(v.button, 'idle')
}

async function voiceStop(v) {
  if (!v || v.stopping) return
  v.stopping = true
  micState(v.button, 'working')
  v.stream.getTracks().forEach((t) => t.stop())
  const ws = v.socket
  if (ws && ws.readyState === 1) {
    const done = new Promise((resolve) => (v.onFinal = resolve))
    ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: VOICE_RATE }))
    await Promise.race([done, sleep(2500)])
    // If the service never confirmed the last phrase, what it had heard so far still counts.
    if (v.partial.trim()) v.box.value = v.kept = joinWords(v.kept, v.partial)
  }
  voiceEnd(v)
}

async function voiceStart(button) {
  if (voice) return voiceStop(voice)
  if (!session()) {
    try {
      await signIn()
    } catch (e) {
      return
    }
  }
  const box = $(button.dataset.mic)
  micState(button, 'starting')
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    micState(button, 'idle')
    toast('Mirg could not use the microphone. Allow it for mirg.ai in your browser (the icon left of the address), then try again.')
    return
  }
  const context = new AudioContext({ sampleRate: VOICE_RATE })
  const v = { button, box, stream, context, socket: null, samples: 0, kept: box.value, partial: '', onFinal: null, stopping: false }
  voice = v
  v.limit = setTimeout(() => voiceStop(v), VOICE_MAX_MS)
  try {
    const { token: pass } = await call('POST', '/voice/token', {})
    const query = new URLSearchParams({ model_id: 'scribe_v2_realtime', audio_format: 'pcm_' + VOICE_RATE, commit_strategy: 'vad', vad_silence_threshold_secs: '0.6', token: pass })
    const ws = new WebSocket('wss://api.elevenlabs.io/v1/speech-to-text/realtime?' + query)
    v.socket = ws
    await new Promise((resolve, reject) => {
      const giveUp = setTimeout(() => reject(new Error('Voice input took too long to start. Try again.')), 10_000)
      ws.onerror = () => reject(new Error('Could not reach the voice service. Check your connection and try again.'))
      ws.onclose = () => reject(new Error('The voice service closed the connection. Try again.'))
      ws.onmessage = (e) => {
        let m = {}
        try {
          m = JSON.parse(String(e.data))
        } catch (err) {}
        switch (m.message_type) {
          case 'session_started':
            clearTimeout(giveUp)
            resolve()
            break
          case 'partial_transcript':
            v.partial = m.text || ''
            box.value = joinWords(v.kept, v.partial)
            break
          case 'committed_transcript':
          case 'committed_transcript_with_timestamps':
            v.partial = ''
            if (m.text && m.text.trim()) box.value = v.kept = joinWords(v.kept, m.text)
            if (v.onFinal) v.onFinal()
            break
          case 'insufficient_audio_activity':
          case 'commit_throttled':
          case 'warning':
            if (v.onFinal) v.onFinal()
            break
          default:
            if (m.error) {
              clearTimeout(giveUp)
              reject(new Error(m.message_type === 'quota_exceeded' ? 'Voice input is at capacity right now. Try again later.' : 'Voice input stopped unexpectedly. Try again.'))
              if (voice === v) {
                toast('Voice input stopped unexpectedly. Try again.')
                voiceEnd(v)
              }
            }
        }
      }
    })
    ws.onclose = () => voice === v && voiceEnd(v)
  } catch (e) {
    voiceEnd(v)
    toast(e.message)
    return
  }
  if (voice !== v) return
  // Raw samples straight from the microphone, sent on as 16-bit audio every few milliseconds.
  const tap = context.createScriptProcessor(2048, 1, 1)
  tap.onaudioprocess = (e) => {
    if (voice !== v || v.stopping || !v.socket || v.socket.readyState !== 1) return
    const samples = e.inputBuffer.getChannelData(0)
    const pcm = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 0x7fff
    const bytes = new Uint8Array(pcm.buffer)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    v.samples += pcm.length
    v.socket.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: btoa(bin), commit: false, sample_rate: VOICE_RATE }))
  }
  context.createMediaStreamSource(stream).connect(tap)
  tap.connect(context.destination)
  micState(button, 'recording')
  box.focus()
}

document.querySelectorAll('[data-mic]').forEach((b) => (b.onclick = () => voiceStart(b)))
window.addEventListener('pagehide', () => voice && voiceEnd(voice))

// ---------------------------------------------------------------------------------------------
// Code view: read and edit the files by hand.

let shownFile = null
let dirty = false

function renderFiles(focus) {
  if (!project) return
  const list = Object.keys(project.files).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)))
  if (focus && project.files[focus] !== undefined) shownFile = focus
  if (!shownFile || project.files[shownFile] === undefined) shownFile = list[0] || null
  $('files').innerHTML = ''
  for (const p of list) {
    const li = document.createElement('li')
    li.textContent = p
    li.title = p
    if (p === shownFile) li.className = 'on'
    li.onclick = () => {
      if (p === shownFile) return
      if (dirty && !confirm('Discard your unsaved changes to ' + shownFile + '?')) return
      setDirty(false)
      shownFile = p
      renderFiles()
    }
    $('files').appendChild(li)
  }
  if (!dirty) $('source').value = shownFile ? project.files[shownFile] : ''
  $('source').placeholder = shownFile ? '' : 'No files yet.'
  $('source').readOnly = Boolean(running) || !shownFile
}

function setDirty(on) {
  dirty = on
  $('code-bar').hidden = !on
}

function saveCode() {
  if (!dirty || !shownFile || running) return
  project.files[shownFile] = $('source').value
  setDirty(false)
  fileChanged(shownFile)
  runGame()
  if (chat()) addItem({ kind: 'notice', text: 'You edited ' + shownFile + '.' })
  // The agent should know, or it will work from what it remembers.
  const c = chat()
  c.pendingNote = (c.pendingNote || []).concat(shownFile)
}

$('source').addEventListener('input', () => setDirty(true))
$('source').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    saveCode()
  } else if (e.key === 'Tab' && !e.shiftKey && !$('source').readOnly) {
    e.preventDefault()
    document.execCommand('insertText', false, '  ')
  }
})
$('save').onclick = saveCode
$('revert').onclick = () => {
  setDirty(false)
  renderFiles()
}

// A plain .zip (stored, not compressed) of every file, for keeping or opening in the desktop app.
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function zip(files) {
  const now = new Date()
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  const parts = []
  const central = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = utf8(text)
    const nameBytes = utf8(name)
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameBytes.length)
    const v = new DataView(local.buffer)
    v.setUint32(0, 0x04034b50, true)
    v.setUint16(4, 20, true)
    v.setUint16(6, 0x0800, true)
    v.setUint16(10, time, true)
    v.setUint16(12, date, true)
    v.setUint32(14, crc, true)
    v.setUint32(18, data.length, true)
    v.setUint32(22, data.length, true)
    v.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    const entry = new Uint8Array(46 + nameBytes.length)
    const w = new DataView(entry.buffer)
    w.setUint32(0, 0x02014b50, true)
    w.setUint16(4, 20, true)
    w.setUint16(6, 20, true)
    w.setUint16(8, 0x0800, true)
    w.setUint16(12, time, true)
    w.setUint16(14, date, true)
    w.setUint32(16, crc, true)
    w.setUint32(20, data.length, true)
    w.setUint32(24, data.length, true)
    w.setUint16(28, nameBytes.length, true)
    w.setUint32(42, offset, true)
    entry.set(nameBytes, 46)
    parts.push(local, data)
    central.push(entry)
    offset += local.length + data.length
  }
  const size = central.reduce((n, e) => n + e.length, 0)
  const end = new Uint8Array(22)
  const e = new DataView(end.buffer)
  e.setUint32(0, 0x06054b50, true)
  e.setUint16(8, central.length, true)
  e.setUint16(10, central.length, true)
  e.setUint32(12, size, true)
  e.setUint32(16, offset, true)
  return new Blob([...parts, ...central, end], { type: 'application/zip' })
}

$('download').onclick = () => {
  if (!project || !Object.keys(project.files).length) return alert('There are no files to download yet.')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(zip(project.files))
  a.download = (project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'game') + '.zip'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

function showTab(tab) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab))
  $('game-wrap').hidden = tab !== 'game'
  $('code').hidden = tab !== 'code'
  if (tab === 'code') renderFiles()
  if (tab === 'game') fitDevice()
}

function showPane(which) {
  $('panes').dataset.show = which
  document.querySelectorAll('#switch [data-show]').forEach((b) => b.classList.toggle('on', b.dataset.show === which))
  if (which === 'game') fitDevice()
}

document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)))
document.querySelectorAll('#switch [data-show]').forEach((b) => (b.onclick = () => showPane(b.dataset.show)))

// ---------------------------------------------------------------------------------------------
// Screens.

/** Games saved before chats existed had one conversation on the game itself. */
function migrate(p) {
  if (!p.chats) {
    const first = (p.items || []).find((i) => i.kind === 'user')
    p.chats = [{ id: newId(), title: first ? first.text.slice(0, 60) : 'New chat', messages: p.messages || [], items: p.items || [], updated: p.updated, contextTokens: 0 }]
    p.chatId = p.chats[0].id
    delete p.messages
    delete p.items
  }
  for (const c of p.chats) {
    for (const item of c.items) if (item.kind === 'step') Object.assign(item, { kind: 'tool', title: item.text })
    if (!c.provider && c.messages.length) c.provider = 'anthropic'
  }
  return p
}

async function showStart() {
  $('settings').hidden = true
  project = null
  if (frame) frame.remove()
  frame = null
  setDirty(false)
  $('studio').hidden = true
  $('start').hidden = false
  clearInterval(commentsTimer)
  document.title = 'Make a game in your browser · Mirg'
  const all = (await myGames()).sort((a, b) => b.updated - a.updated)
  $('mine').hidden = !all.length
  $('cards').innerHTML = ''
  for (const p of all) {
    const card = document.createElement('div')
    card.className = 'card'
    const name = document.createElement('strong')
    name.textContent = p.name
    const info = document.createElement('span')
    info.className = 'fine'
    info.textContent = 'Edited ' + when(p.updated) + (p.share ? ' · Shared' : '')
    const row = document.createElement('div')
    row.className = 'row'
    const open = document.createElement('a')
    open.className = 'btn small primary'
    open.href = '#g=' + p.id
    open.textContent = 'Open'
    const del = document.createElement('button')
    del.className = 'linklike'
    del.type = 'button'
    del.textContent = 'Delete'
    del.onclick = async () => {
      if (!confirm('Delete "' + p.name + '" from this browser? This cannot be undone.' + (p.share ? ' The shared link keeps working.' : ''))) return
      await db.del(p.id)
      showStart()
    }
    row.append(open, del)
    // Ideas from players on a shared game: a badge that opens the game's Comments panel.
    if (p.share && session()) {
      call('POST', '/feedback/count', { slug: p.share.slug })
        .then((r) => {
          if (!r.count) return
          const badge = document.createElement('button')
          badge.type = 'button'
          badge.className = 'comments-new'
          badge.textContent = (r.count > 99 ? '99+' : r.count) + ' new'
          badge.title = 'Ideas from players for this game'
          badge.setAttribute('aria-label', 'Ideas from players for ' + p.name)
          badge.onclick = () => {
            commentsOnOpen = p.id
            location.hash = '#g=' + p.id
          }
          row.insertBefore(badge, del)
        })
        .catch(() => undefined)
    }
    card.append(name, info, row)
    $('cards').appendChild(card)
  }
}

function openProject(p) {
  $('settings').hidden = true
  project = migrate(p)
  $('start').hidden = true
  $('studio').hidden = false
  $('title').textContent = p.name
  document.title = p.name + ' · Mirg'
  lastRestore = null
  $('restored').hidden = true
  queue = []
  renderQueue()
  pendingFiles = []
  renderPending()
  shownFile = null
  setDirty(false)
  renderPickers()
  renderChat()
  showTab('game')
  showPane('chat')
  runGame()
  checkComments()
  if (commentsOnOpen === p.id) openComments()
  commentsOnOpen = null
}

// ---------------------------------------------------------------------------------------------
// Comments: what players said about a shared game. Mirg reads new comments into suggestions; each can
// be sent to the agent in one click (Fix it) or dismissed. The same panel as the desktop app's.

let commentsCount = 0
let commentsTimer = null
// A game opened from its "new" badge on the start page opens with its Comments panel.
let commentsOnOpen = null

function showCommentsButton() {
  const b = $('comments-btn')
  b.hidden = !(project && project.share && session() && commentsCount > 0)
  b.textContent = (commentsCount > 99 ? '99+' : commentsCount) + ' new'
  b.setAttribute('aria-label', 'Comments from players, ' + commentsCount + ' new')
}

/** The count on the Comments button: a cheap check, no model. On opening a game, then every 5 minutes. */
function checkComments() {
  clearInterval(commentsTimer)
  commentsCount = 0
  showCommentsButton()
  if (!project || !project.share || !session()) return
  const id = project.id
  const check = () =>
    call('POST', '/feedback/count', { slug: project.share.slug })
      .then((r) => {
        if (project && project.id === id) {
          commentsCount = r.count || 0
          showCommentsButton()
        }
      })
      .catch(() => undefined)
  check()
  commentsTimer = setInterval(check, 5 * 60_000)
}

function fixPrompt(list) {
  if (list.length === 1) return 'Players left comments on this game. A change drawn from them: "' + list[0].body + '" Make this change if it suits the game, and tell me what you did.'
  return 'Players left comments on this game. Changes drawn from them:\n' + list.map((s, i) => i + 1 + '. ' + s.body).join('\n') + '\nMake these changes where they suit the game, and tell me what you did for each.'
}

function ago(at) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60_000))
  if (mins < 60) return mins <= 1 ? 'just now' : mins + 'm ago'
  const hours = Math.round(mins / 60)
  return hours < 24 ? hours + 'h ago' : Math.round(hours / 24) + 'd ago'
}

async function openComments() {
  if (!project || !project.share) return
  const body = $('comments-body')
  body.innerHTML = '<p class="fine comments-loading">Reading new comments…</p>'
  $('commentsbox').showModal()
  let feedback
  try {
    feedback = await call('POST', '/feedback', { slug: project.share.slug })
  } catch (e) {
    body.innerHTML = ''
    const p = document.createElement('p')
    p.className = 'error'
    p.textContent = e.message || 'The comments could not be loaded.'
    body.appendChild(p)
    return
  }
  let showDone = false
  const resolve = (s, status) => {
    feedback.suggestions = feedback.suggestions.filter((x) => x.id !== s.id)
    if (status === 'accepted') feedback.done.unshift(s)
    call('POST', '/suggestions/resolve', { id: s.id, status }).catch(() => undefined)
  }
  const fix = (list) => {
    for (const s of list) resolve(s, 'accepted')
    commentsCount = feedback.suggestions.length
    showCommentsButton()
    $('commentsbox').close()
    showPane('chat')
    $('input').value = fixPrompt(list)
    $('composer').requestSubmit()
  }
  const el = (tag, cls, text) => {
    const x = document.createElement(tag)
    if (cls) x.className = cls
    if (text !== undefined) x.textContent = text
    return x
  }
  const draw = () => {
    // New comments were read just now, so the button counts only what is still waiting.
    commentsCount = feedback.suggestions.length
    showCommentsButton()
    body.innerHTML = ''
    const open = feedback.suggestions
    const head = el('div', 'comments-section-head')
    head.appendChild(el('h3', '', 'Suggestions'))
    if (open.length > 1) {
      const all = el('button', 'btn small primary', 'Fix all ' + open.length)
      all.type = 'button'
      all.onclick = () => fix(open.slice())
      head.appendChild(all)
    }
    body.appendChild(head)
    if (open.length) {
      body.appendChild(el('p', 'fine', 'Drawn from what players wrote. Fix it asks the agent to make the change, which uses your plan.'))
      for (const s of open) {
        const row = el('div', 'suggestion')
        const text = el('span', 'suggestion-body', s.body)
        text.appendChild(el('span', 'suggestion-from', s.comments + ' player' + (s.comments === 1 ? '' : 's')))
        const dismiss = el('button', 'linklike', 'Dismiss')
        dismiss.type = 'button'
        dismiss.setAttribute('aria-label', 'Dismiss: ' + s.body)
        dismiss.onclick = () => {
          resolve(s, 'dismissed')
          draw()
        }
        const go = el('button', 'btn small', 'Fix it')
        go.type = 'button'
        go.setAttribute('aria-label', 'Fix it: ' + s.body)
        go.onclick = () => fix([s])
        row.append(text, dismiss, go)
        body.appendChild(row)
      }
    } else {
      body.appendChild(el('p', 'fine', feedback.comments.length ? 'Nothing to change right now. New comments are read each time you open this.' : "No comments yet. Share your game's link and players can comment under it."))
    }
    if (feedback.done.length) {
      const done = el('div', 'comments-done')
      const t = el('button', 'linklike', '✓ Fixed (' + feedback.done.length + ')')
      t.type = 'button'
      t.setAttribute('aria-expanded', String(showDone))
      t.onclick = () => {
        showDone = !showDone
        draw()
      }
      done.appendChild(t)
      if (showDone) {
        const ul = el('ul')
        for (const s of feedback.done) ul.appendChild(el('li', '', s.body))
        done.appendChild(ul)
      }
      body.appendChild(done)
    }
    if (feedback.comments.length) {
      const fresh = feedback.comments.filter((c) => c.fresh).length
      const h = el('div', 'comments-section-head')
      h.appendChild(el('h3', '', 'What players wrote'))
      if (fresh) h.appendChild(el('span', 'comments-new-count', fresh + ' new'))
      body.appendChild(h)
      const ul = el('ul', 'comments-list')
      for (const c of feedback.comments) {
        const li = el('li', c.fresh ? 'fresh' : '')
        const meta = el('span', 'comment-meta', c.name + ' · ' + ago(c.at))
        if (c.fresh) meta.appendChild(el('span', 'comment-new', 'New'))
        li.append(meta, el('span', 'comment-body', c.body))
        ul.appendChild(li)
      }
      body.appendChild(ul)
    }
  }
  draw()
}
$('comments-btn').onclick = () => openComments()
$('comments-close').onclick = () => $('commentsbox').close()

async function route() {
  if (location.hash === '#settings') return showSettings()
  $('settings').hidden = true
  const id = /^#g=(.+)$/.exec(location.hash)
  if (!id) return showStart()
  if (project && project.id === id[1]) {
    $('start').hidden = true
    $('studio').hidden = false
    document.title = project.name + ' · Mirg'
    renderPickers()
    fitDevice()
    return
  }
  const p = (await myGames()).find((x) => x.id === id[1])
  if (!p) {
    history.replaceState(null, '', '/create')
    return showStart()
  }
  openProject(p)
}

window.addEventListener('hashchange', () => {
  // Settings can be opened while the agent works; it carries on in the background.
  const toSettings = location.hash === '#settings'
  const backToGame = project && location.hash === '#g=' + project.id
  if (running && !toSettings && !backToGame) {
    history.replaceState(null, '', project ? '#g=' + project.id : '/create')
    return
  }
  if (dirty && !toSettings && !backToGame && !confirm('Discard your unsaved code changes?')) return
  route()
})

function showSettings() {
  $('start').hidden = true
  $('studio').hidden = true
  $('settings').hidden = false
  document.title = 'Settings · Mirg'
  $('settings-back').href = project ? '#g=' + project.id : '/create'
  $('settings-back').textContent = project ? 'Back to ' + project.name : 'Back'
  const fill = (el, list, value, label) => {
    el.innerHTML = ''
    let group = null
    for (const x of list) {
      if (x.group && (!group || group.label !== x.group)) {
        group = document.createElement('optgroup')
        group.label = x.group
        el.appendChild(group)
      }
      const o = document.createElement('option')
      o.value = x.id
      o.textContent = label(x)
      ;(x.group ? group : el).appendChild(o)
    }
    el.value = value
  }
  const model = currentModel()
  fill($('pref-model'), MODELS, model, (m) => m.label + ' · ' + m.hint)
  fill($('pref-effort'), EFFORTS, settings.effort, (e) => e.label + ' · ' + e.hint)
  $('pref-effort').disabled = !hasEffort(model)
  $('pref-device').value = settings.device
  myGames()
    .then((all) => {
      const shared = all.filter((p) => p.share).length
      $('settings-games').textContent = all.length
        ? all.length + (all.length === 1 ? ' game' : ' games') + ' saved in this browser' + (shared ? ', ' + shared + ' shared' : '') + '. Clearing your browser\'s data for mirg.ai deletes them; shared games stay online.'
        : 'No games saved in this browser yet.'
    })
    .catch(() => undefined)
  renderAccountSettings()
}

$('pref-model').onchange = (e) => {
  settings.model = e.target.value
  keepSettings()
  showSettings()
}
$('pref-effort').onchange = (e) => {
  settings.effort = e.target.value
  keepSettings()
}
$('pref-device').onchange = (e) => {
  settings.device = e.target.value
  keepSettings()
}

/** Whose games these are: each account sees only its own games in this browser. */
function owner() {
  const s = session()
  return s && s.email ? s.email.toLowerCase() : null
}

/** The signed-in account's games. Games made before accounts were kept apart go to whoever is signed in first. */
async function myGames() {
  const who = owner()
  if (!who) return []
  const all = await db.all().catch(() => [])
  for (const p of all)
    if (!p.owner) {
      p.owner = who
      db.put(p).catch(() => undefined)
    }
  return all.filter((p) => p.owner === who)
}

function blankProject(name) {
  const chatId = newId()
  return { id: newId(), owner: owner(), name, files: {}, chats: [{ id: chatId, title: 'New chat', messages: [], items: [], updated: Date.now(), contextTokens: 0 }], chatId, updated: Date.now(), share: null }
}

async function startGame(text) {
  text = text.trim()
  if (!text) return
  if (!session()) {
    try {
      await signIn()
    } catch (e) {
      return
    }
  }
  if (!me) await refreshMe()
  const p = blankProject(text.split(/\s+/).slice(0, 6).join(' ').replace(/[.,!?]+$/, '') || 'My game')
  await db.put(p).catch(() => undefined)
  history.pushState(null, '', '#g=' + p.id)
  openProject(p)
  agent(text)
}

$('start-form').onsubmit = (e) => {
  e.preventDefault()
  startGame($('start-text').value)
}
$('start-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    startGame($('start-text').value)
  }
})
/** Three ideas picked at random from the list, so the start page is different each visit. */
function showIdeas() {
  const pool = IDEAS.slice()
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  $('ideas').innerHTML = ''
  for (const idea of pool.slice(0, 3)) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = idea
    b.onclick = () => {
      $('start-text').value = idea
      $('start-text').focus()
    }
    $('ideas').appendChild(b)
  }
  $('start-text').placeholder = pool[3]
}
showIdeas()
$('more-ideas').onclick = showIdeas

$('errors').onclick = () => fixErrors(false)

$('composer').onsubmit = async (e) => {
  e.preventDefault()
  let text = $('input').value.trim()
  if ((!text && !pendingFiles.length) || !project) return
  if (!session()) {
    try {
      await signIn()
    } catch (ex) {
      return
    }
  }
  const c = chat()
  if (c.pendingNote && c.pendingNote.length) {
    text += '\n\n[The user edited ' + [...new Set(c.pendingNote)].join(', ') + ' by hand since your last turn. Read it before changing it.]'
    c.pendingNote = []
  }
  const files = pendingFiles
  pendingFiles = []
  renderPending()
  $('input').value = ''
  if (running) {
    queue.push({ text, files })
    renderQueue()
    return
  }
  agent(text || (files.some((f) => f.kind === 'image') ? 'Here is a picture.' : 'Here is a file.'), files)
}
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    $('composer').requestSubmit()
  }
})
$('stop').onclick = () => running && running.abort()
$('restart').onclick = () => runGame()
$('stop-game').onclick = () => stopGame()
$('mute').onclick = () => setGameMuted(!gameMuted)
showMuted()
$('home').onclick = (e) => {
  if (running && !confirm('Mirg is still working on this game. Leave anyway?')) e.preventDefault()
  else if (running) running.abort()
}

// ---------------------------------------------------------------------------------------------
// Sharing: the same upload as the desktop app, so the game lands on play.mirg.ai.

// Tags: up to 5 short words people find the game by. Mirg's AI suggests them when a game is shared
// for the first time; the creator adds and removes freely. The server tidies them and refuses
// offensive ones.
let shareTags = []
const TAGS_MAX = 5
function tidyTag(text) {
  return String(text).toLowerCase().replace(/^#+/, '').replace(/[^\p{L}\p{N} &'-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 24).trim()
}
function renderTags() {
  const list = $('share-tag-list')
  list.textContent = ''
  for (const tag of shareTags) {
    const chip = document.createElement('span')
    chip.className = 'tag-chip'
    chip.textContent = tag
    const x = document.createElement('button')
    x.type = 'button'
    x.setAttribute('aria-label', 'Remove ' + tag)
    x.textContent = '×'
    x.onclick = () => {
      shareTags = shareTags.filter((t) => t !== tag)
      renderTags()
    }
    chip.appendChild(x)
    list.appendChild(chip)
  }
  $('share-tag-input').hidden = shareTags.length >= TAGS_MAX
}
function addTag(text) {
  const tag = tidyTag(text)
  if (!tag || shareTags.includes(tag) || shareTags.length >= TAGS_MAX) return
  shareTags.push(tag)
  renderTags()
}
$('share-tag-input').addEventListener('keydown', (e) => {
  const input = e.target
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    addTag(input.value)
    input.value = ''
  } else if (e.key === 'Backspace' && !input.value && shareTags.length) {
    shareTags.pop()
    renderTags()
  }
})
$('share-tag-input').addEventListener('blur', (e) => {
  if (e.target.value.trim()) {
    addTag(e.target.value)
    e.target.value = ''
  }
})
// The game's code for the AI to read: index.html first, then its scripts, cut short.
function codeForSuggestion(files) {
  const names = Object.keys(files).filter((n) => typeof files[n] === 'string' && /\.(html?|m?js)$/i.test(n))
  names.sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : 0))
  let out = ''
  for (const n of names) {
    if (out.length > 24000) break
    out += '\n// ' + n + '\n' + files[n]
  }
  return out.slice(0, 24000)
}
async function suggestDetails(withDescription) {
  const title = titleOf(project.files) || project.name
  return call('POST', '/share/suggest', { title, code: codeForSuggestion(project.files), description: withDescription })
}
$('share-describe').onclick = async () => {
  const b = $('share-describe')
  b.disabled = true
  b.textContent = 'Writing…'
  try {
    const out = await suggestDetails(true)
    if (out.description) $('share-description').value = out.description
    if (!shareTags.length && out.tags) {
      for (const t of out.tags) addTag(t)
    }
  } catch (e) {
    toast(e.message)
  } finally {
    b.disabled = false
    b.textContent = 'Write it with AI'
  }
}

/** A picture of the running game for its card on the games page, or null if it cannot be taken. */
async function snapshot() {
  if (!frame) {
    if (!project.files['index.html']) return null
    await runGame()
    await sleep(2500)
  }
  const reply = await ask({ type: 'snapshot' }, 4000)
  const url = reply && reply.ok ? reply.value : null
  if (!url || url.length < 3000) return null
  // An all-black or blank frame says nothing about the game.
  return (await looksBlank(url)) ? null : url
}

async function looksBlank(url) {
  try {
    const img = new Image()
    // Not img.decode(): a browser can put that off while the tab is in the background.
    const ok = await Promise.race([
      new Promise((resolve) => {
        img.onload = () => resolve(true)
        img.onerror = () => resolve(false)
        img.src = url
      }),
      sleep(2000).then(() => null)
    ])
    if (ok === null) return false
    if (!ok) return true
    const c = document.createElement('canvas')
    c.width = 32
    c.height = 18
    const x = c.getContext('2d')
    x.drawImage(img, 0, 0, 32, 18)
    const d = x.getImageData(0, 0, 32, 18).data
    let min = 255
    let max = 0
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    return max - min < 6
  } catch (e) {
    return true
  }
}

/** When the game cannot be pictured: a card with its name. */
function titleCard(title) {
  const c = document.createElement('canvas')
  c.width = 800
  c.height = 450
  const x = c.getContext('2d')
  const g = x.createLinearGradient(0, 0, 800, 450)
  g.addColorStop(0, '#1d2340')
  g.addColorStop(1, '#4a1f4f')
  x.fillStyle = g
  x.fillRect(0, 0, 800, 450)
  x.fillStyle = '#fff'
  x.textAlign = 'center'
  x.textBaseline = 'middle'
  let size = 64
  x.font = '700 ' + size + 'px -apple-system, Segoe UI, Roboto, sans-serif'
  while (x.measureText(title).width > 700 && size > 28) x.font = '700 ' + (size -= 4) + 'px -apple-system, Segoe UI, Roboto, sans-serif'
  x.fillText(title, 400, 210)
  x.fillStyle = 'rgba(255,255,255,0.6)'
  x.font = '500 22px -apple-system, Segoe UI, Roboto, sans-serif'
  x.fillText('Made with Mirg', 400, 290)
  return c.toDataURL('image/jpeg', 0.85)
}

/** A picture the user picked, cropped to the games page's 16:9 card. */
async function readCover(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const w = 800
    const h = 450
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const x = c.getContext('2d')
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight)
    const dw = img.naturalWidth * scale
    const dh = img.naturalHeight * scale
    x.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
    return c.toDataURL('image/jpeg', 0.85)
  } finally {
    URL.revokeObjectURL(url)
  }
}

let sharePicture = null
function showSharePicture(url, note) {
  sharePicture = url
  $('share-picture').src = url || ''
  $('share-picture').hidden = !url
  $('share-picture-note').textContent = note || ''
}

let pictureTicket = 0
async function takeSharePicture() {
  const ticket = ++pictureTicket
  const forProject = project
  showSharePicture(null, 'Taking a picture of the game…')
  const shot = await snapshot().catch(() => null)
  // A picture that arrives after the box moved on to something else is not used.
  if (ticket !== pictureTicket || forProject !== project || !$('sharebox').open) return
  if (shot) showSharePicture(shot, 'A picture of your game as it is now.')
  else showSharePicture(titleCard(titleOf(project.files) || project.name), "Your game couldn't be pictured, so it gets a card with its name. Take a picture when it shows something, or upload your own.")
}

$('share-retake').onclick = async () => {
  if (project.cover) {
    delete project.cover
    save()
  }
  showTab('game')
  await takeSharePicture()
}
$('share-upload').onclick = () => $('share-upload-input').click()
$('share-upload-input').onchange = async (e) => {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  try {
    project.cover = await readCover(f)
    pictureTicket++
    save()
    showSharePicture(project.cover, 'Your picture. It shows on the games page.')
  } catch (err) {
    toast('Could not read that picture. Try a PNG or JPEG.')
  }
}

$('share').onclick = async () => {
  if (!project) return
  if (!project.files['index.html']) {
    alert('There is no game to share yet. Describe one in the chat first.')
    return
  }
  if (!session()) {
    try {
      await signIn()
    } catch (e) {
      return
    }
  }
  $('share-error').hidden = true
  $('share-progress').textContent = ''
  const shared = project.share
  $('share-link').hidden = !shared
  if (shared) {
    $('share-url').value = shared.url
    $('share-open').href = shared.url
    $('share-listed').checked = shared.listed !== false
    $('share-phone').checked = Boolean(shared.phone)
  }
  $('share-go').textContent = shared ? 'Update shared game' : 'Share'
  $('share-go').disabled = false
  // Tags and description as last shared; a game with no tags yet gets Mirg's suggestions.
  shareTags = shared && Array.isArray(shared.tags) ? shared.tags.slice(0, TAGS_MAX) : []
  $('share-description').value = (shared && shared.description) || ''
  $('share-tags-note').textContent = ''
  renderTags()
  $('sharebox').showModal()
  if (!shareTags.length) {
    const asked = project
    $('share-tags-note').textContent = 'Suggesting tags…'
    suggestDetails(false)
      .then((out) => {
        if (project !== asked || shareTags.length) return
        for (const t of out.tags || []) addTag(t)
        $('share-tags-note').textContent = shareTags.length ? 'Suggested by Mirg. Remove any, or add your own.' : ''
      })
      .catch(() => ($('share-tags-note').textContent = ''))
  }
  if (project.cover) showSharePicture(project.cover, 'Your picture. It shows on the games page.')
  else await takeSharePicture()
}
$('share-close').onclick = () => $('sharebox').close()
$('share-copy').onclick = () => {
  navigator.clipboard && navigator.clipboard.writeText($('share-url').value).catch(() => undefined)
  $('share-url').select()
  $('share-copy').textContent = 'Copied'
  setTimeout(() => ($('share-copy').textContent = 'Copy'), 1500)
}
$('share-form').onsubmit = async (e) => {
  e.preventDefault()
  const p = project
  $('share-go').disabled = true
  $('share-error').hidden = true
  try {
    const title = titleOf(p.files) || p.name
    const info = JSON.stringify({ title, madeWith: 'Mirg' })
    const bodies = Object.assign({}, p.files, { 'mirg-share.json': info })
    // The game's card on the games page.
    const picture = sharePicture || p.cover || titleCard(title)
    bodies['mirg-thumb.jpg'] = Uint8Array.from(atob(picture.split(',')[1]), (ch) => ch.charCodeAt(0))
    const bytes = (v) => (typeof v === 'string' ? utf8(v) : v)
    const files = Object.keys(bodies).map((path) => ({ path, size: bytes(bodies[path]).length }))
    const pending = $('share-tag-input').value.trim()
    if (pending) {
      addTag(pending)
      $('share-tag-input').value = ''
    }
    const opts = { listed: $('share-listed').checked, phone: $('share-phone').checked, tags: shareTags.slice(), description: $('share-description').value.trim() }
    $('share-progress').textContent = 'Uploading ' + files.length + ' files…'
    const start = await call('POST', '/share/start', Object.assign({ slug: p.share ? p.share.slug : undefined, title, files }, opts))
    let done = 0
    const queue = start.uploads.slice()
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        let response = null
        for (let attempt = 0; attempt < 3 && !(response && response.ok); attempt++) {
          response = await fetch(next.url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'true' }, body: bytes(bodies[next.path] || '') }).catch(() => null)
        }
        if (!response || !response.ok) throw new Error('Could not upload ' + next.path + '. Check your connection and try again.')
        done++
        $('share-progress').textContent = 'Uploaded ' + done + ' of ' + start.uploads.length + ' files'
      }
    }
    try {
      await Promise.all([worker(), worker(), worker(), worker()])
    } catch (err) {
      if (!p.share) await call('DELETE', '/share/' + encodeURIComponent(start.slug)).catch(() => undefined)
      throw err
    }
    p.share = Object.assign({ slug: start.slug, url: start.url }, opts)
    if (project === p) checkComments()
    save()
    $('share-progress').textContent = 'Shared. Anyone with this link can play it:'
    $('share-url').value = start.url
    $('share-open').href = start.url
    $('share-link').hidden = false
    $('share-go').textContent = 'Update shared game'
  } catch (err) {
    $('share-error').textContent = err.message
    $('share-error').hidden = false
    $('share-progress').textContent = ''
  } finally {
    $('share-go').disabled = false
  }
}
// ---------------------------------------------------------------------------------------------

if (!(await finishGoogleSignIn())) {
  renderAccount()
  refreshMe().then(renderPickers)
  renderPickers()
  route()
  // Sent here from the stats page to sign in (/create?then=stats): back there once signed in.
  if (new URLSearchParams(location.search).get('then') === 'stats') {
    if (session()) location.replace('/stats')
    else signIn().then(() => location.replace('/stats'), () => undefined)
  }
}
// Arriving from "Make a game" with an idea already typed: /create?idea=...
const idea = new URLSearchParams(location.search).get('idea')
if (idea && !location.hash) $('start-text').value = idea.slice(0, 4000)

// Testing hooks, for checking the game frame and chat without a model.
window.__mirgCreate = {
  bundle,
  runGame,
  runTool,
  zip,
  get logs() {
    return logs
  },
  get project() {
    return project
  },
  open(files) {
    const p = blankProject('Test')
    p.files = files
    openProject(p)
    return p
  },
  addItem
}
