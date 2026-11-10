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

function renderAccount() {
  document.querySelectorAll('[data-account]').forEach((el) => {
    const s = session()
    if (!s) {
      el.innerHTML = '<button type="button" class="linklike" data-signin>Sign in</button>'
      return
    }
    let usage = ''
    if (me && me.allowanceMicros > 0) {
      const pct = Math.min(100, Math.round((me.usedMicros / me.allowanceMicros) * 100))
      const plan = me.plan === 'free' ? 'Free' : me.plan === 'pro' ? 'Pro' : 'Max'
      usage = '<span class="plan-text">' + plan + ' · ' + pct + '% used</span><span class="meter" title="' + pct + '% of this month\'s usage"><span style="width:' + pct + '%"></span></span>'
    }
    el.innerHTML = usage + '<button type="button" class="linklike" data-signout title="' + escapeHtml(s.email) + '">Sign out</button>'
  })
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-signin]')) signIn().catch(() => undefined)
  if (e.target.closest('[data-signout]')) {
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
  {
    name: 'game_eval',
    description:
      'Run JavaScript inside the running game and get the result as JSON. Give an expression (e.g. "window.__game.player.x") or statements ending in return (await is allowed). Use it to read exact state.',
    input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }
  },
  {
    name: 'game_input',
    description:
      'Play the running game. Actions run in order: {"key": "ArrowRight", "ms": 500} holds a key (key names as in KeyboardEvent.key, e.g. "a", " ", "Enter", "ArrowUp"); {"tap": [x, y], "ms": 60} clicks or taps at a point in CSS pixels of the game view; {"wait": 300} waits. Returns any new errors. Read the effect with game_eval afterwards.',
    input_schema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, ms: { type: 'number' }, tap: { type: 'array', items: { type: 'number' } }, wait: { type: 'number' } }
          }
        }
      },
      required: ['actions']
    }
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

async function runTool(name, input) {
  const files = project.files
  switch (name) {
    case 'list_files': {
      const list = Object.keys(files).sort()
      return list.length ? list.map((p) => p + ' (' + utf8(files[p]).length + ' bytes)').join('\n') : 'The project is empty.'
    }
    case 'read_file': {
      const path = checkPath(input.path)
      if (files[path] === undefined) throw new Error('There is no file ' + path + '.')
      const text = files[path]
      return text.length > 60000 ? text.slice(0, 60000) + '\n…(file continues; it is ' + text.length + ' characters long)' : text
    }
    case 'write_file': {
      const path = checkPath(input.path)
      const content = String(input.content == null ? '' : input.content)
      if (utf8(content).length > MAX_FILE_BYTES) throw new Error('That file is too big for Mirg on the web. Split it into smaller modules.')
      if (files[path] === undefined && Object.keys(files).length >= MAX_FILES) throw new Error('The project has too many files. Combine some.')
      const existed = files[path] !== undefined
      files[path] = content
      fileChanged(path)
      step((existed ? 'Updated ' : 'Created ') + path)
      return (existed ? 'Replaced ' : 'Created ') + path + ' (' + content.split('\n').length + ' lines).'
    }
    case 'edit_file': {
      const path = checkPath(input.path)
      const text = files[path]
      if (text === undefined) throw new Error('There is no file ' + path + '.')
      const from = String(input.old_string || '')
      const to = String(input.new_string == null ? '' : input.new_string)
      if (!from) throw new Error('old_string is empty.')
      const count = text.split(from).length - 1
      if (count === 0) throw new Error('old_string was not found in ' + path + '. Read the file and copy the text exactly.')
      if (count > 1 && !input.replace_all) throw new Error('old_string appears ' + count + ' times in ' + path + '. Add surrounding lines to make it unique, or set replace_all.')
      files[path] = input.replace_all ? text.split(from).join(to) : text.replace(from, () => to)
      fileChanged(path)
      step('Edited ' + path)
      return 'Edited ' + path + (count > 1 ? ' (' + count + ' places)' : '') + '.'
    }
    case 'delete_file': {
      const path = checkPath(input.path)
      if (files[path] === undefined) throw new Error('There is no file ' + path + '.')
      delete files[path]
      fileChanged(path)
      step('Deleted ' + path)
      return 'Deleted ' + path + '.'
    }
    case 'run_game': {
      if (!files['index.html']) throw new Error('There is no index.html yet, so there is nothing to run.')
      showTab('game')
      const ok = await runGame()
      await sleep(2000)
      const errors = logs.filter((l) => l.level === 'error').length
      step('Ran the game: ' + (errors ? errors + (errors === 1 ? ' error' : ' errors') : 'no errors'), errors > 0)
      return (ok ? 'The game loaded.' : 'The page did not finish loading within 8 seconds.') + '\n' + logText(logs, 60)
    }
    case 'game_eval': {
      const reply = await ask({ type: 'eval', code: String(input.code || '') }, 8000)
      step('Checked the game')
      if (!reply.ok) throw new Error(reply.value)
      return reply.value
    }
    case 'game_input': {
      const actions = Array.isArray(input.actions) ? input.actions.slice(0, 50) : []
      const before = logs.length
      const total = actions.reduce((n, a) => n + (Number(a.ms) || 80) + (Number(a.wait) || 0), 0)
      const reply = await ask({ type: 'input', actions }, Math.min(60000, total + 5000))
      step('Played the game')
      if (!reply.ok) throw new Error(reply.value)
      const fresh = logs.slice(before)
      return 'Done.' + (fresh.length ? '\n' + logText(fresh, 30) : ' Nothing new in the console.')
    }
    case 'game_logs':
      return logText(logs, 120)
    default:
      throw new Error('Unknown tool ' + name)
  }
}

function fileChanged(path) {
  const t = titleOf(project.files)
  if (t && t !== project.name) {
    project.name = t
    $('title').textContent = t
  }
  save()
  renderFiles(path)
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
The loop is: build, run, check, fix.
- Write all the files of a small game in one reply. A single reply must not write more than about 300 lines of code in total, because a very long reply is cut off: for a bigger game, split the code into modules of a few hundred lines and write one or two per reply.
- Then call run_game. Errors it reports are yours to fix before you reply.
- Verify behaviour, not just loading: expose the game's live state on a global, e.g. window.__game = { player, enemies, score, state }, then use game_input to play (move, jump, shoot, press the start button) and game_eval to read exact state. Call several tools in one reply when they do not depend on each other.
- Every step costs the user part of their plan, so match the checking to the job. For a small game or change: one run_game, one short playtest with game_eval, and if clean, stop. Do not re-read files you just wrote or test what you did not change. Save repeated playtesting for bigger games and anything that failed.
- Match the build to the request: "a simple Pong game" wants a small, clean game, not title screens, settings and systems nobody asked for.
- Say what you verified and what you could not. Finish with a short summary of what changed and how to play (the controls), not a list of files.

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

const IDEAS = ['A platformer where a fox collects coins and dodges spikes', 'A space shooter with waves of aliens and a boss', 'Snake, but the snake is a train', 'A 3D maze where you escape a ghost', 'Flappy-style game with a paper plane', 'A two-player tank battle on one keyboard']

let running = null

function modelFor() {
  return me && me.plan !== 'free' ? 'claude-opus-5-5' : 'claude-sonnet-5-5'
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

/** One model response, streamed. Returns { blocks, stop }. */
async function respond(signal, ui) {
  const t = await token()
  if (!t) throw Object.assign(new Error('Your session ended. Sign in again.'), { signin: true })
  const response = await fetch(API + '/proxy/anthropic/v1/messages?beta=true', {
    method: 'POST',
    signal,
    headers: { authorization: 'Bearer ' + t, 'x-mirg-device': device(), 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: modelFor(),
      max_tokens: 12000,
      stream: true,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      messages: withCache(project.messages)
    })
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const err = (data && data.error) || {}
    throw Object.assign(new Error(err.message || 'The model request failed (' + response.status + ').'), { code: err.type || err.code, status: response.status })
  }
  const blocks = []
  let stop = null
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
      if (ev.type === 'content_block_start') {
        const b = Object.assign({}, ev.content_block)
        if (b.type === 'tool_use') {
          b.json = ''
          ui.status('Working: ' + toolLabel(b.name) + '…')
        }
        if (b.type === 'thinking') ui.status('Thinking…')
        if (b.type === 'text') b.text = b.text || ''
        blocks[ev.index] = b
      } else if (ev.type === 'content_block_delta') {
        const b = blocks[ev.index]
        const d = ev.delta
        if (!b) continue
        if (d.type === 'text_delta') {
          b.text += d.text
          ui.text(b)
        } else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking
        else if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature
        else if (d.type === 'input_json_delta') b.json += d.partial_json
      } else if (ev.type === 'content_block_stop') {
        const b = blocks[ev.index]
        if (b && b.type === 'tool_use') {
          try {
            b.input = b.json ? JSON.parse(b.json) : {}
          } catch (e) {
            b.broken = true
            b.input = {}
          }
          delete b.json
        }
      } else if (ev.type === 'message_delta') {
        if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason
      } else if (ev.type === 'error') {
        throw new Error((ev.error && ev.error.message) || 'The model stopped with an error.')
      }
    }
  }
  return { blocks: blocks.filter(Boolean), stop }
}

function toolLabel(name) {
  return { write_file: 'writing a file', edit_file: 'editing a file', read_file: 'reading a file', run_game: 'running the game', game_eval: 'checking the game', game_input: 'playing the game', delete_file: 'deleting a file' }[name] || 'looking around'
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

async function agent(text) {
  if (running) return
  const controller = new AbortController()
  running = controller
  setRunning(true)
  let note = ''
  if (!project.messages.length && Object.keys(project.files).length) note = '\n\n(The project already has these files: ' + Object.keys(project.files).sort().join(', ') + '.)'
  project.messages.push({ role: 'user', content: text + note })
  addItem({ kind: 'user', text })
  save()
  const statusEl = addStatus('Thinking…')
  let changed = false
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let live = null
      const ui = {
        status: (s) => (statusEl.textContent = s),
        text: (b) => {
          if (!live) live = addLive()
          live.innerHTML = markdown(b.text)
          scrollLog()
        }
      }
      const { blocks, stop } = await respond(controller.signal, ui)
      if (live) live.remove()
      let content = clean(blocks)
      if (stop === 'max_tokens') {
        content = content.filter((b) => b.type !== 'tool_use')
        if (!content.some((b) => b.type === 'text')) content.push({ type: 'text', text: '(My reply was cut off because it was too long.)' })
        project.messages.push({ role: 'assistant', content })
        project.messages.push({ role: 'user', content: 'Your last reply was cut off because it was too long, and nothing in it was run. Write less per reply: split big files into modules of a few hundred lines and write one or two per reply.' })
        continue
      }
      if (!content.length) content.push({ type: 'text', text: '(no reply)' })
      project.messages.push({ role: 'assistant', content })
      for (const b of content) if (b.type === 'text') addItem({ kind: 'agent', text: b.text })
      save()
      const calls = content.filter((b) => b.type === 'tool_use')
      if (stop !== 'tool_use' || !calls.length) {
        if (stop === 'refusal') addItem({ kind: 'error', text: 'The model declined this request. Try describing the game differently.' })
        break
      }
      const results = []
      for (const c of calls) {
        if (controller.signal.aborted) break
        let out
        let isError = false
        try {
          out = await runTool(c.name, c.input || {})
          if (/^(write|edit|delete)_file$/.test(c.name)) changed = true
          if (c.name === 'run_game') changed = false
        } catch (e) {
          out = e.message
          isError = true
        }
        results.push({ type: 'tool_result', tool_use_id: c.id, content: String(out).slice(0, 30000), is_error: isError || undefined })
      }
      // Every tool call needs an answer, even when the user pressed Stop part way through.
      for (const c of calls) if (!results.some((r) => r.tool_use_id === c.id)) results.push({ type: 'tool_result', tool_use_id: c.id, content: 'Stopped by the user.', is_error: true })
      project.messages.push({ role: 'user', content: results })
      save()
      if (controller.signal.aborted) break
      if (round === MAX_ROUNDS - 1) addItem({ kind: 'status', text: 'Paused after many steps. Send "keep going" to continue.' })
    }
  } catch (e) {
    if (e.name === 'AbortError' || controller.signal.aborted) addItem({ kind: 'status', text: 'Stopped.' })
    else {
      addItem({ kind: 'error', text: e.message, limit: e.code === 'mirg_limit' || e.code === 'mirg_device' || e.code === 'mirg_capacity' })
      if (e.signin) signIn().catch(() => undefined)
    }
    // A failed request leaves the user's message last; that is a valid place to carry on from.
    const last = project.messages[project.messages.length - 1]
    if (last && last.role === 'assistant' && last.content.some((b) => b.type === 'tool_use')) project.messages.pop()
  } finally {
    statusEl.remove()
    running = null
    setRunning(false)
    save()
    if (changed || !frame) runGame()
    refreshMe()
  }
}

function setRunning(on) {
  $('send').hidden = on
  $('stop').hidden = !on
  $('input').placeholder = on ? 'Mirg is working…' : 'Ask for a change: a double jump, a boss, more enemies…'
}

window.addEventListener('beforeunload', (e) => {
  if (running) {
    e.preventDefault()
    e.returnValue = ''
  }
})

// ---------------------------------------------------------------------------------------------
// Chat display.

function markdown(text) {
  const inline = (s) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  const out = []
  let list = null
  for (const line of text.split('\n')) {
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
  return out.map((x) => (Array.isArray(x) ? '<ul>' + x.join('') + '</ul>' : x)).join('')
}

function scrollLog() {
  const log = $('log')
  log.scrollTop = log.scrollHeight
}

function renderItem(item) {
  const el = document.createElement('div')
  if (item.kind === 'user') {
    el.className = 'msg user'
    el.textContent = item.text
  } else if (item.kind === 'agent') {
    el.className = 'msg agent'
    el.innerHTML = markdown(item.text)
  } else if (item.kind === 'step') {
    el.className = 'msg step' + (item.bad ? ' bad' : '')
    el.textContent = item.text
  } else if (item.kind === 'error') {
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
    el.className = 'msg status'
    el.textContent = item.text
  }
  $('log').appendChild(el)
  return el
}

function addItem(item) {
  project.items.push(item)
  if (project.items.length > 400) project.items.splice(0, project.items.length - 400)
  renderItem(item)
  scrollLog()
}

function step(text, bad) {
  addItem({ kind: 'step', text, bad: Boolean(bad) })
}

function addStatus(text) {
  const el = document.createElement('div')
  el.className = 'msg status'
  el.textContent = text
  $('log').appendChild(el)
  scrollLog()
  // Keep the status line last while other lines are added.
  const keepLast = new MutationObserver(() => {
    if (el.parentNode && el.nextSibling && !el.nextSibling.classList.contains('live')) $('log').appendChild(el)
  })
  keepLast.observe($('log'), { childList: true })
  const remove = el.remove.bind(el)
  el.remove = () => {
    keepLast.disconnect()
    remove()
  }
  return el
}

function addLive() {
  const el = document.createElement('div')
  el.className = 'msg agent live'
  $('log').appendChild(el)
  return el
}

// ---------------------------------------------------------------------------------------------
// Code view.

let shownFile = null
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
      shownFile = p
      renderFiles()
    }
    $('files').appendChild(li)
  }
  $('source').textContent = shownFile ? project.files[shownFile] : 'No files yet.'
}

function showTab(tab) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab))
  $('game-wrap').hidden = tab !== 'game'
  $('code').hidden = tab !== 'code'
  if (tab === 'code') renderFiles()
  if (tab === 'game' && window.matchMedia('(max-width: 800px)').matches && running) showPane('game')
}

function showPane(which) {
  $('panes').dataset.show = which
  document.querySelectorAll('#switch [data-show]').forEach((b) => b.classList.toggle('on', b.dataset.show === which))
}

document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)))
document.querySelectorAll('#switch [data-show]').forEach((b) => (b.onclick = () => showPane(b.dataset.show)))

// ---------------------------------------------------------------------------------------------
// Screens.

async function showStart() {
  project = null
  if (frame) frame.remove()
  frame = null
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
    const when = document.createElement('span')
    when.className = 'fine'
    when.textContent = 'Edited ' + new Date(p.updated).toLocaleString() + (p.share ? ' · Shared' : '')
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
    card.append(name, when, row)
    $('cards').appendChild(card)
  }
}

function openProject(p) {
  project = p
  $('start').hidden = true
  $('studio').hidden = false
  $('title').textContent = p.name
  document.title = p.name + ' · Mirg'
  $('log').innerHTML = ''
  for (const item of p.items) renderItem(item)
  scrollLog()
  showTab('game')
  showPane('chat')
  shownFile = null
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
  route()
})

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
  const p = { id: newId(), name: text.split(/\s+/).slice(0, 6).join(' ').replace(/[.,!?]+$/, '') || 'My game', files: {}, messages: [], items: [], updated: Date.now(), share: null }
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
  const text = $('input').value.trim()
  if (!text || running) return
  if (!session()) {
    try {
      await signIn()
    } catch (ex) {
      return
    }
  }
  $('input').value = ''
  agent(text)
}
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    $('composer').requestSubmit()
  }
})
$('stop').onclick = () => running && running.abort()
$('restart').onclick = () => runGame()
$('new-chat').onclick = () => {
  if (running || !project) return
  project.messages = []
  project.items = []
  $('log').innerHTML = ''
  addItem({ kind: 'status', text: 'New chat. The game is unchanged; ask for the next change.' })
  save()
}
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
refreshMe()
route()
// Arriving from "Make a game" with an idea already typed: /create?idea=...
const idea = new URLSearchParams(location.search).get('idea')
if (idea && !location.hash) $('start-text').value = idea.slice(0, 4000)

// Testing hooks, for checking the game frame without a model.
window.__mirgCreate = { bundle, runGame, runTool, get logs() { return logs }, open: (files) => { const p = { id: newId(), name: 'Test', files, messages: [], items: [], updated: Date.now(), share: null }; openProject(p); return p } }
