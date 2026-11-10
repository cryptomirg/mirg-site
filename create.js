// Mirg on the web: describe a game, and an AI agent writes it, runs it and fixes it right here in
// the browser. The agent loop runs on this page and calls the model through Mirg's API, which
// meters usage against the account's plan exactly as it does for the desktop app. Games are kept
// in this browser (IndexedDB) and run in a sandboxed frame that cannot see this page or its sign-in.

const SUPABASE = 'https://dlnmbeqdtpyjkprkxfvt.supabase.co'
const KEY = 'sb_publishable_RTQ8CSTfuHByAw1-_bbqag_NX0-kQhp'
const API = SUPABASE + '/functions/v1/api'
const CATEGORIES = ['Action', 'Adventure', 'Arcade', 'Card & Casino', 'Party', 'Shooter', 'Sports', 'Strategy', 'Other']
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
    headers: Object.assign({ authorization: 'Bearer ' + t, 'x-mirg-device': device() }, body === undefined ? {} : { 'content-type': 'application/json' }),
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
    el.innerHTML = '<button type="button" class="account-open" data-account-open title="Your account, plan and usage (' + escapeHtml(s.email) + ')">' + inside + '<span class="avatar">' + escapeHtml((s.email[0] || '?').toUpperCase()) + '</span></button>'
  })
}

/** Your account: plan, this period's usage, upgrading and billing, like Settings in the app. */
async function openAccount() {
  const box = $('accountbox')
  const body = $('account-body')
  const s = session()
  if (!s) return signIn().catch(() => undefined)
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
    const resets = me.periodEnd ? ' · resets ' + new Date(me.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
    add('<div class="usage-bar"><span style="width:' + pct + '%"></span></div><div class="fine usage-line"><span>' + tokens(me.usedTokens || 0) + ' tokens used this ' + (me.plan === 'free' ? 'month' : 'period') + '</span><span>' + (pct >= 100 ? 'All' : pct + '%') + ' of your plan' + resets + '</span></div>', 'usage')
    if (me.bonus && me.bonus.leftMicros > 0) add('Includes ' + usd(me.bonus.micros) + ' of free credit' + (me.bonus.until ? ', until ' + new Date(me.bonus.until).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '') + '.', 'fine')
    if (me.plan === 'free') {
      const plans = add('', 'plans')
      for (const [kind, name, price, what] of [
        ['pro', 'Pro', '$20 / month', "For regular game-making: 14 times the free plan's usage, and Claude Opus by default"],
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
  box.showModal()
  await refreshMe()
  if (box.open) draw(me ? '' : 'Could not reach Mirg to load your usage.')
}

window.addEventListener('focus', () => {
  // Back from paying in another tab: show the new plan.
  if (session()) refreshMe().then(() => $('accountbox').open && openAccount())
})

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-signin]')) signIn().catch(() => undefined)
  if (e.target.closest('[data-account-open]')) openAccount()
  if (e.target.closest('[data-signout]')) {
    $('accountbox').close()
    const s = session()
    store.set(SESSION_KEY, null)
    me = null
    renderAccount()
    if (s) fetch(SUPABASE + '/auth/v1/logout', { method: 'POST', headers: { apikey: KEY, authorization: 'Bearer ' + s.accessToken } }).catch(() => undefined)
  }
})

/** Ask for an email and the code sent to it. Resolves once signed in; rejects if cancelled. */
function signIn() {
  const box = $('signin')
  const err = $('signin-error')
  let stage = 'email'
  let email = ''
  $('email-row').hidden = false
  $('code-row').hidden = true
  $('signin-code').required = false
  $('signin-go').textContent = 'Email me a code'
  err.hidden = true
  box.showModal()
  setTimeout(() => $('email').focus(), 0)
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
    $('signin-form').onsubmit = async (e) => {
      e.preventDefault()
      err.hidden = true
      $('signin-go').disabled = true
      try {
        if (stage === 'email') {
          email = $('email').value.trim().toLowerCase()
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.')
          await auth('otp', { email, create_user: true })
          stage = 'code'
          $('email-row').hidden = true
          $('code-row').hidden = false
          $('signin-code').required = true
          $('signin-go').textContent = 'Sign in'
          $('signin-note').textContent = 'We sent a code to ' + email + '. It can take a minute; check spam too.'
          $('signin-code').focus()
        } else {
          keep(await auth('verify', { type: 'email', email, token: $('signin-code').value.trim() }), email)
          await refreshMe()
          done(true)
        }
      } catch (ex) {
        err.textContent = ex.message
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
addEventListener('message',async function(e){if(e.source!==parent)return;var m=e.data||{};
if(m.type==='eval'){try{var r;try{r=(0,eval)('('+m.code+'\\n)')}catch(se){if(!(se instanceof SyntaxError))throw se;r=(0,eval)('(async function(){'+m.code+'\\n})()')}if(r&&typeof r.then==='function')r=await r;P({type:'evalResult',id:m.id,ok:true,value:fmt(r,true)})}catch(err){P({type:'evalResult',id:m.id,ok:false,value:String(err&&err.stack||err)})}}
if(m.type==='input'){try{for(var i=0;i<(m.actions||[]).length;i++)await act(m.actions[i]);P({type:'inputDone',id:m.id,ok:true})}catch(err){P({type:'inputDone',id:m.id,ok:false,value:String(err)})}}});
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
  boot.textContent = 'window.__mirgFiles=' + JSON.stringify(data).replace(/</g, '\\u003c') + ';\n' + BOOT
  doc.head.insertBefore(boot, doc.head.firstChild)
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}

let frame = null
let logs = []
let loaded = null
const pending = new Map()

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
  $('errors').textContent = n === 1 ? '1 error' : n + ' errors'
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
    description: 'Create a file or replace its whole content. Use for new files and full rewrites; prefer edit_file for small changes.',
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
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'Best for building games. The default on Pro and Max.' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'Faster and half the cost. The default on the free plan.' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', hint: 'Fastest and cheapest. Good for small tweaks.', effort: false },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', hint: 'Most capable, most expensive.' }
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
const currentModel = () => (MODELS.some((m) => m.id === settings.model) ? settings.model : me && me.plan !== 'free' ? 'claude-opus-5-5' : 'claude-sonnet-5-5')
const hasEffort = (model) => !MODELS.some((m) => m.id === model && m.effort === false)

function renderPickers() {
  const model = currentModel()
  const fill = (el, list, value, label) => {
    el.innerHTML = ''
    for (const x of list) {
      const o = document.createElement('option')
      o.value = x.id
      o.textContent = label(x)
      o.title = x.hint
      el.appendChild(o)
    }
    el.value = value
    el.title = (list.find((x) => x.id === value) || {}).hint || ''
  }
  fill($('pick-model'), MODELS, model, (m) => m.label)
  fill($('pick-effort'), EFFORTS, settings.effort, (e) => 'Think: ' + e.label)
  $('pick-effort').hidden = !hasEffort(model)
  $('device').value = settings.device
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
- Write all the files of a small game in one reply. A single reply must not write more than about 300 lines of code in total, because a very long reply is cut off: for a bigger game, split the code into modules of a few hundred lines and write one or two per reply.
- Then call run_game once. Errors it reports are yours to fix before you reply; when it reports none, stop and hand the game over.
- Every step costs the user part of their plan, so do not re-read files you just wrote or re-run the game when nothing changed.
- Match the build to the request: "a simple Pong game" wants a small, clean game, not title screens, settings and systems nobody asked for.
- Finish with a short summary of what changed and how to play (the controls), not a list of files.

# Every game
- Shared games are often opened on phones, so add simple touch controls as well as keyboard and mouse (tap, swipe, or a few large on-screen buttons shown only on touch devices), size the canvas to the window and handle resizing, and start audio on the first input.
- The game runs in a sandboxed frame. Do not rely on cookies or on fetching files that are not in the project.
- Give index.html a <title> with the game's name.

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

const IDEAS = ['A platformer where a fox collects coins and dodges spikes', 'A space shooter with waves of aliens and a boss', 'Snake, but the snake is a train', 'A 3D maze where you escape a ghost', 'Flappy-style game with a paper plane', 'A two-player tank battle on one keyboard']

let running = null
let startedAt = 0
let queue = []
let queuePaused = false

function chat() {
  return project.chats.find((c) => c.id === project.chatId) || project.chats[0]
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

/** One model response, streamed. Returns { blocks, stop, billed, context }. */
async function respond(signal, ui, opts) {
  opts = opts || {}
  const t = await token()
  if (!t) throw Object.assign(new Error('Your session ended. Sign in again.'), { signin: true })
  const model = currentModel()
  const body = {
    model,
    max_tokens: 12000,
    stream: true,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: TOOLS,
    messages: withCache(opts.messages || chat().messages)
  }
  if (hasEffort(model)) {
    body.thinking = { type: 'adaptive', display: 'summarized' }
    body.output_config = { effort: settings.effort }
  }
  if (opts.noTools) body.tool_choice = { type: 'none' }
  const response = await fetch(API + '/proxy/anthropic/v1/messages?beta=true', {
    method: 'POST',
    signal,
    headers: { authorization: 'Bearer ' + t, 'x-mirg-device': device(), 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const err = (data && data.error) || {}
    throw Object.assign(new Error(err.message || 'The model request failed (' + response.status + ').'), { code: err.type || err.code, status: response.status })
  }
  const blocks = []
  let stop = null
  const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let cut
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      const line = chunk.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      let ev
      try {
        ev = JSON.parse(line.slice(5).trim())
      } catch (e) {
        continue
      }
      if (ev.type === 'message_start' && ev.message && ev.message.usage) {
        const u = ev.message.usage
        usage.input = u.input_tokens || 0
        usage.cacheWrite = u.cache_creation_input_tokens || 0
        usage.cacheRead = u.cache_read_input_tokens || 0
        usage.output = u.output_tokens || 0
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
  }
  return { blocks: blocks.filter(Boolean), stop, billed: usage.input + usage.cacheWrite + usage.output, context: usage.input + usage.cacheWrite + usage.cacheRead }
}

function clean(blocks) {
  const out = []
  for (const b of blocks) {
    if (b.type === 'text') {
      if (b.text && b.text.trim()) out.push({ type: 'text', text: b.text })
    } else if (b.type === 'thinking') out.push({ type: 'thinking', thinking: b.thinking || '', signature: b.signature || '' })
    else if (b.type === 'redacted_thinking') out.push({ type: 'redacted_thinking', data: b.data })
    else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input || {} })
  }
  return out
}

const quietUi = { start() {}, delta() {}, stop() {} }

/** When the conversation has grown long, replace it with a summary written by the model. */
async function compact(c, signal) {
  if ((c.contextTokens || 0) < COMPACT_AT || !c.messages.length) return ''
  const notice = addItem({ kind: 'notice', text: 'Summarizing earlier messages to keep the conversation fast…' })
  const messages = c.messages.slice()
  const last = messages[messages.length - 1]
  if (last.role === 'user') {
    const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.slice()
    content.push({ type: 'text', text: SUMMARY_REQUEST })
    messages[messages.length - 1] = { role: 'user', content }
  } else messages.push({ role: 'user', content: SUMMARY_REQUEST })
  const { blocks } = await respond(signal, quietUi, { messages, noTools: true })
  const summary = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
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

async function agent(text, images) {
  if (running || !project) return
  images = images || []
  const c = chat()
  const controller = new AbortController()
  running = controller
  startedAt = Date.now()
  lastRestore = null
  $('restored').hidden = true
  setRunning(true)
  let changed = false
  let userItem = null
  const toolItems = new Map()
  try {
    const recap = await compact(c, controller.signal)
    let note = ''
    if (!c.messages.length && !recap && Object.keys(project.files).length) note = '\n\n(The project already has these files: ' + Object.keys(project.files).sort().join(', ') + '.)'
    // Older snapshots are dropped so a long session does not fill the browser's storage.
    const turns = c.items.filter((i) => i.kind === 'user' && i.before)
    for (const old of turns.slice(0, Math.max(0, turns.length - 24))) delete old.before
    userItem = addItem({ kind: 'user', text, pics: images.map((i) => i.thumb), before: JSON.parse(JSON.stringify(project.files)), mark: c.messages.length, tokens: 0, ms: 0 })
    if (!c.title || c.title === 'New chat') {
      c.title = text.replace(/\s+/g, ' ').slice(0, 60) || 'Chat'
      renderChatName()
    }
    const words = recap + text + note + deviceNote()
    const content = images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })).concat([{ type: 'text', text: words }])
    const prev = c.messages[c.messages.length - 1]
    // After an error or Stop the history can end on the user's side: carry on in the same turn.
    if (prev && prev.role === 'user') {
      c.messages[c.messages.length - 1] = { role: 'user', content: (typeof prev.content === 'string' ? [{ type: 'text', text: prev.content }] : prev.content).concat(content) }
      userItem.mark = c.messages.length - 1
    } else c.messages.push({ role: 'user', content })
    save()
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
          if (item && b.type === 'thinking') {
            item.live = false
            item.ms = Date.now() - item.t0
            refresh(item)
          }
        }
      }
      let result
      try {
        result = await respond(controller.signal, ui, null)
      } finally {
        working.remove()
      }
      const { blocks, stop } = result
      userItem.tokens += result.billed
      c.contextTokens = result.context
      // Text that came to nothing leaves no empty bubble behind.
      for (const [b, item] of live) if (b.type === 'text' && !b.text.trim()) removeItem(item)
      let content = clean(blocks)
      if (stop === 'max_tokens') {
        for (const b of content) if (b.type === 'tool_use' && toolItems.get(b.id)) Object.assign(toolItems.get(b.id), { running: false, bad: true, title: 'Cut off: the reply was too long' })
        toolItems.forEach(refresh)
        content = content.filter((b) => b.type !== 'tool_use')
        if (!content.some((b) => b.type === 'text')) content.push({ type: 'text', text: '(My reply was cut off because it was too long.)' })
        c.messages.push({ role: 'assistant', content })
        c.messages.push({ role: 'user', content: 'Your last reply was cut off because it was too long, and nothing in it was run. Write less per reply: split big files into modules of a few hundred lines and write one or two per reply.' })
        continue
      }
      if (!content.length) content.push({ type: 'text', text: '(no reply)' })
      c.messages.push({ role: 'assistant', content })
      save()
      const calls = content.filter((b) => b.type === 'tool_use')
      if (stop !== 'tool_use' || !calls.length) {
        if (stop === 'refusal') addItem({ kind: 'error', text: 'The model declined this request. Try describing the game differently.' })
        break
      }
      const results = []
      for (const call of calls) {
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
        results.push({ type: 'tool_result', tool_use_id: call.id, content: String(out).slice(0, 30000), is_error: isError || undefined })
      }
      // Every tool call needs an answer, even when the user pressed Stop part way through.
      for (const call of calls) if (!results.some((r) => r.tool_use_id === call.id)) results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Stopped by the user.', is_error: true })
      c.messages.push({ role: 'user', content: results })
      save()
      if (controller.signal.aborted) break
      if (round === MAX_ROUNDS - 1) addItem({ kind: 'notice', text: 'Paused after many steps. Send "keep going" to continue.' })
    }
  } catch (e) {
    if (e.name === 'AbortError' || controller.signal.aborted) addItem({ kind: 'notice', text: 'Stopped.' })
    else {
      addItem({ kind: 'error', text: e.message, limit: e.code === 'mirg_limit' || e.code === 'mirg_device' || e.code === 'mirg_capacity' })
      if (e.signin) signIn().catch(() => undefined)
      queuePaused = queue.length > 0
    }
    // A failed request leaves the user's message last; that is a valid place to carry on from.
    const last = c.messages[c.messages.length - 1]
    if (last && last.role === 'assistant' && last.content.some((b) => b.type === 'tool_use')) c.messages.pop()
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
  agent(next.text, next.images)
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
    if (item.limit) {
      const a = document.createElement('a')
      a.href = '/pricing'
      a.target = '_blank'
      a.textContent = ' See plans'
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
// Pictures attached to a message: a sketch of a level, a screenshot of a game to match.

let pendingPics = []
const MAX_PICS = 4

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
    return { mediaType: 'image/jpeg', data: draw(1568, 0.85).split(',')[1], thumb: draw(160, 0.7) }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function attach(files) {
  const pictures = [...files].filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type))
  if (files.length && !pictures.length) return alert('Only pictures (PNG, JPEG, WebP or GIF) can be attached here.')
  for (const f of pictures) {
    if (pendingPics.length >= MAX_PICS) {
      alert('Up to ' + MAX_PICS + ' pictures per message.')
      break
    }
    try {
      pendingPics.push(await readPicture(f))
    } catch (e) {
      alert('Could not read ' + f.name + '.')
    }
  }
  renderPending()
}

function renderPending() {
  const box = $('pending')
  box.innerHTML = ''
  box.hidden = !pendingPics.length
  pendingPics.forEach((p, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'pic'
    const img = document.createElement('img')
    img.src = p.thumb
    img.alt = 'Attached picture'
    const x = document.createElement('button')
    x.type = 'button'
    x.textContent = '×'
    x.title = 'Remove'
    x.onclick = () => {
      pendingPics.splice(i, 1)
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
    span.textContent = q.text || q.images.length + ' picture(s)'
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
  for (const c of p.chats) for (const item of c.items) if (item.kind === 'step') Object.assign(item, { kind: 'tool', title: item.text })
  return p
}

async function showStart() {
  project = null
  if (frame) frame.remove()
  frame = null
  setDirty(false)
  $('studio').hidden = true
  $('start').hidden = false
  document.title = 'Make a game in your browser · Mirg'
  const all = (await db.all().catch(() => [])).sort((a, b) => b.updated - a.updated)
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
    card.append(name, info, row)
    $('cards').appendChild(card)
  }
}

function openProject(p) {
  project = migrate(p)
  $('start').hidden = true
  $('studio').hidden = false
  $('title').textContent = p.name
  document.title = p.name + ' · Mirg'
  lastRestore = null
  $('restored').hidden = true
  queue = []
  renderQueue()
  pendingPics = []
  renderPending()
  shownFile = null
  setDirty(false)
  renderPickers()
  renderChat()
  showTab('game')
  showPane('chat')
  runGame()
}

async function route() {
  const id = /^#g=(.+)$/.exec(location.hash)
  if (!id) return showStart()
  if (project && project.id === id[1]) return
  const p = (await db.all().catch(() => [])).find((x) => x.id === id[1])
  if (!p) {
    history.replaceState(null, '', '/create')
    return showStart()
  }
  openProject(p)
}

window.addEventListener('hashchange', () => {
  if (running) return
  if (dirty && !confirm('Discard your unsaved code changes?')) return
  route()
})

function blankProject(name) {
  const chatId = newId()
  return { id: newId(), name, files: {}, chats: [{ id: chatId, title: 'New chat', messages: [], items: [], updated: Date.now(), contextTokens: 0 }], chatId, updated: Date.now(), share: null }
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
for (const idea of IDEAS) {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = idea
  b.onclick = () => {
    $('start-text').value = idea
    $('start-text').focus()
  }
  $('ideas').appendChild(b)
}

$('composer').onsubmit = async (e) => {
  e.preventDefault()
  let text = $('input').value.trim()
  if ((!text && !pendingPics.length) || !project) return
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
  const images = pendingPics
  pendingPics = []
  renderPending()
  $('input').value = ''
  if (running) {
    queue.push({ text, images })
    renderQueue()
    return
  }
  agent(text || 'Here is a picture.', images)
}
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    $('composer').requestSubmit()
  }
})
$('stop').onclick = () => running && running.abort()
$('restart').onclick = () => runGame()
$('home').onclick = (e) => {
  if (running && !confirm('Mirg is still working on this game. Leave anyway?')) e.preventDefault()
  else if (running) running.abort()
}

// ---------------------------------------------------------------------------------------------
// Sharing: the same upload as the desktop app, so the game lands on play.mirg.ai.

for (const c of CATEGORIES) {
  const o = document.createElement('option')
  o.value = c
  o.textContent = c
  $('share-category').appendChild(o)
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
    $('share-category').value = shared.category || 'Other'
    $('share-listed').checked = shared.listed !== false
    $('share-phone').checked = Boolean(shared.phone)
  }
  $('share-go').textContent = shared ? 'Update shared game' : 'Share'
  $('share-go').disabled = false
  $('sharebox').showModal()
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
    const files = Object.keys(bodies).map((path) => ({ path, size: utf8(bodies[path]).length }))
    const opts = { listed: $('share-listed').checked, category: $('share-category').value, phone: $('share-phone').checked }
    $('share-progress').textContent = 'Uploading ' + files.length + ' files…'
    const start = await call('POST', '/share/start', Object.assign({ slug: p.share ? p.share.slug : undefined, title, files }, opts))
    let done = 0
    const queue = start.uploads.slice()
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        let response = null
        for (let attempt = 0; attempt < 3 && !(response && response.ok); attempt++) {
          response = await fetch(next.url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'true' }, body: utf8(bodies[next.path] || '') }).catch(() => null)
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

renderAccount()
refreshMe().then(renderPickers)
renderPickers()
route()
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
