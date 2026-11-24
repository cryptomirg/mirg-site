// Mirg's side of an app: the page around an app (mirg.ai/play, and the web builder's preview)
// answers the requests an app makes through the Mirg toolkit (play.mirg.ai/_mirg/app.js).
//
// Apps never hold a Mirg sign-in or anyone's data themselves. They ask this page, which knows which
// app is asking (by the frame the request came from, never by what the app says), and then:
//   device.*   keeps data on this device, under that app's own name
//   user/signIn   says who is using it (an id for this app only, never the email)
//   data.*     keeps the person's own data in their Mirg account (sign-in first)
//   shared.*   lists everyone using the app shares, such as a sign-up sheet
//   ai.*       asks Mirg's AI, paid from the person's own Mirg tokens after they agree, once per app
// In the builder's preview, account data and shared lists are kept on this device as stand-ins, so
// the maker can try everything before sharing.
;(function () {
  var SUPABASE = 'https://dlnmbeqdtpyjkprkxfvt.supabase.co'
  var KEY = 'sb_publishable_RTQ8CSTfuHByAw1-_bbqag_NX0-kQhp'
  var API = SUPABASE + '/functions/v1/api'
  var DATA = SUPABASE + '/functions/v1/app-data'
  var SESSION_KEY = 'mirg-web-session'
  var DEVICE_LIMIT = 2 * 1024 * 1024 // characters of on-device data per app
  var AI_MAX_OUTPUT = 4096
  var AI_MAX_PROMPT = 60000
  var AI_MAX_FILE = 15 * 1024 * 1024
  var AI_PER_APP_PER_DAY = 60 // AI requests one app may make for one person on one device in a day
  var AI_TOKENS_PER_APP_PER_DAY = 50000 // Mirg tokens one app may use for one person on one device in a day

  function lsGet(k) {
    try {
      return localStorage.getItem(k)
    } catch (e) {
      return null
    }
  }
  function lsSet(k, v) {
    try {
      if (v === null) localStorage.removeItem(k)
      else localStorage.setItem(k, v)
      return true
    } catch (e) {
      return false
    }
  }
  function lsKeys(prefix) {
    var out = []
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i)
        if (k && k.indexOf(prefix) === 0) out.push(k.slice(prefix.length))
      }
    } catch (e) {}
    return out.sort()
  }
  function readJson(k, fallback) {
    try {
      var v = lsGet(k)
      return v === null ? fallback : JSON.parse(v)
    } catch (e) {
      return fallback
    }
  }

  // ---------- the visitor's Mirg session (the same one the web builder keeps) ----------

  function session() {
    return readJson(SESSION_KEY, null)
  }
  var refreshing = null
  function token() {
    var s = session()
    if (!s) return Promise.resolve(null)
    if (s.expiresAt - Date.now() > 60000) return Promise.resolve(s.accessToken)
    refreshing =
      refreshing ||
      fetch(SUPABASE + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: KEY, 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refreshToken }) })
        .then(function (r) {
          return r.ok ? r.json() : null
        })
        .then(function (d) {
          if (!d || !d.access_token) {
            lsSet(SESSION_KEY, null)
            return null
          }
          var fresh = { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: Date.now() + (d.expires_in || 3600) * 1000, email: (d.user && d.user.email) || s.email }
          lsSet(SESSION_KEY, JSON.stringify(fresh))
          return fresh.accessToken
        })
        .catch(function () {
          return null
        })
        .then(function (t) {
          refreshing = null
          return t
        })
    return refreshing
  }
  function device() {
    var id = lsGet('mirg-web-device')
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)
      lsSet('mirg-web-device', id)
    }
    return id
  }

  // ---------- small dialogs, drawn by Mirg (an app cannot draw over them or change them) ----------

  var STYLE =
    '.mirg-host-dlg{border:1px solid rgba(255,255,255,.14);border-radius:14px;background:#141414;color:#ededed;padding:20px;max-width:min(420px,calc(100vw - 32px));font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 24px 60px rgba(0,0,0,.45)}' +
    '.mirg-host-dlg::backdrop{background:rgba(8,9,16,.6)}' +
    '.mirg-host-dlg h2{font-size:18px;margin:0 0 8px}.mirg-host-dlg p{margin:0 0 12px;color:#a4a4a4}' +
    '.mirg-host-dlg .row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:16px}' +
    '.mirg-host-dlg button{font:inherit;border-radius:9px;padding:8px 14px;border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;cursor:pointer}' +
    '.mirg-host-dlg button.go{background:#fff;border-color:#fff;color:#0a0a0a;font-weight:600}' +
    '.mirg-host-dlg .who{font-size:13px;color:#8a8a8a;margin-top:-4px}'
  function ensureStyle() {
    if (document.getElementById('mirg-host-style')) return
    var st = document.createElement('style')
    st.id = 'mirg-host-style'
    st.textContent = STYLE
    document.head.appendChild(st)
  }
  /** A question with buttons; resolves with the chosen button's value (null when dismissed). */
  function ask(title, text, buttons, note) {
    ensureStyle()
    return new Promise(function (resolve) {
      var d = document.createElement('dialog')
      d.className = 'mirg-host-dlg'
      var h = document.createElement('h2')
      h.textContent = title
      d.appendChild(h)
      if (note) {
        var n = document.createElement('p')
        n.className = 'who'
        n.textContent = note
        d.appendChild(n)
      }
      var p = document.createElement('p')
      p.textContent = text
      d.appendChild(p)
      var row = document.createElement('div')
      row.className = 'row'
      var answer = null
      buttons.forEach(function (b) {
        var el = document.createElement('button')
        el.type = 'button'
        el.textContent = b.label
        if (b.primary) el.className = 'go'
        el.onclick = function () {
          answer = b.value
          // Opened here, in the click itself, so the browser does not block the new tab.
          if (b.open) window.open(b.open, '_blank', 'noopener,noreferrer')
          d.close()
        }
        row.appendChild(el)
      })
      d.appendChild(row)
      d.addEventListener('close', function () {
        d.remove()
        resolve(answer)
      })
      document.body.appendChild(d)
      d.showModal()
    })
  }

  /** Sign in with Mirg, in a small window of the web builder's own sign-in. Resolves true once signed in. */
  function signInWindow() {
    if (session()) return Promise.resolve(true)
    var w = window.open('/create?signin=window', 'mirg-signin', 'width=480,height=640')
    if (!w) {
      location.href = '/create?return=' + encodeURIComponent(location.pathname + location.search)
      return new Promise(function () {})
    }
    var started = Date.now()
    return new Promise(function (resolve) {
      var t = setInterval(function () {
        if (session()) {
          clearInterval(t)
          try {
            w.close()
          } catch (e) {}
          return resolve(true)
        }
        if ((w.closed && Date.now() - started > 1500) || Date.now() - started > 15 * 60000) {
          clearInterval(t)
          resolve(Boolean(session()))
        }
      }, 400)
    })
  }

  function error(code, message) {
    var e = new Error(message)
    e.code = code
    return e
  }

  function base64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader()
      r.onload = function () {
        resolve(String(r.result).split(',')[1] || '')
      }
      r.onerror = function () {
        reject(error('file', 'That file could not be read.'))
      }
      r.readAsDataURL(blob)
    })
  }

  // ---------- one app in one frame ----------

  /**
   * opts: frame (the iframe), slug (the shared app; null in the builder's preview), title (shown in
   * Mirg's prompts), preview (true in the builder), key (a name for this app's data on this device:
   * the slug, or the builder's project id).
   */
  function attach(opts) {
    // Only as the top page: inside someone else's frame, this page answers nothing.
    if (window.top !== window) return { detach: function () {} }
    var frame = opts.frame
    var preview = Boolean(opts.preview)
    var title = opts.title || 'This app'
    var devicePrefix = (preview ? 'mirg-app-preview:' : 'mirg-app:') + (opts.key || opts.slug || 'app') + ':'
    var localData = 'mirg-app-preview-data:' + (opts.key || 'app') + ':'
    var localLists = 'mirg-app-preview-lists:' + (opts.key || 'app') + ':'
    var aiAllowedKey = 'mirg-app-ai-ok:' + (opts.slug || opts.key || 'app')
    var aiDayKey = 'mirg-app-ai-day:' + (opts.slug || opts.key || 'app')

    // Before anything goes into a shared list for the first time in an app, Mirg says plainly who will
    // see it, so an app cannot pass off a list everyone can read (its maker included) as private.
    var sharedOkKey = 'mirg-app-shared-ok:' + (opts.slug || opts.key || 'app')
    function sharedConsent(collection) {
      var agreed = readJson(sharedOkKey, [])
      if (preview || agreed.indexOf(collection) >= 0) return Promise.resolve()
      return ask(
        'Share this with everyone using the app?',
        'What you add here goes on a list that everyone using this app can see, including the person who made it. Do not add anything private, such as bank, card, health or ID details.',
        [
          { label: 'Cancel', value: false },
          { label: 'Add it', value: true, primary: true }
        ],
        title
      ).then(function (yes) {
        if (!yes) throw error('shared_declined', 'Not added.')
        agreed.push(collection)
        lsSet(sharedOkKey, JSON.stringify(agreed))
      })
    }

    function remote(body) {
      return token().then(function (t) {
        body.slug = opts.slug
        return fetch(DATA, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, t ? { authorization: 'Bearer ' + t } : {}), body: JSON.stringify(body) })
          .catch(function () {
            throw error('offline', 'Mirg could not be reached. Check the connection.')
          })
          .then(function (r) {
            return r.json().catch(function () {
              return {}
            }).then(function (d) {
              if (!r.ok) throw error((d.error && d.error.code) || 'error', (d.error && d.error.message) || 'Mirg could not do that right now.')
              return d
            })
          })
      })
    }

    /** Make sure someone is signed in, asking them first. */
    function needSignIn(why) {
      if (session()) return Promise.resolve()
      return ask('Sign in with Mirg', why, [
        { label: 'Not now', value: false },
        { label: 'Sign in', value: true, primary: true }
      ], title).then(function (yes) {
        if (!yes) throw error('sign_in', 'Not signed in.')
        return signInWindow().then(function (ok) {
          if (!ok) throw error('sign_in', 'Not signed in.')
        })
      })
    }

    function withSignIn(why, fn) {
      return needSignIn(why).then(fn).catch(function (e) {
        // The session ran out meanwhile: ask once more.
        if (e.code === 'mirg_sign_in' && !preview) {
          lsSet(SESSION_KEY, null)
          return needSignIn(why).then(fn)
        }
        throw e
      })
    }

    // ---------- on this device ----------
    function deviceUsed(skip) {
      var n = 0
      lsKeys(devicePrefix).forEach(function (k) {
        if (k !== skip) n += (lsGet(devicePrefix + k) || '').length + k.length
      })
      return n
    }
    var deviceOps = {
      'device.get': function (a) {
        var v = lsGet(devicePrefix + String(a.key))
        return v === null ? null : JSON.parse(v)
      },
      'device.set': function (a) {
        var key = String(a.key)
        var text = JSON.stringify(a.value === undefined ? null : a.value)
        if (deviceUsed(key) + text.length > DEVICE_LIMIT) throw error('full', 'This app has saved as much as it can on this device.')
        if (!lsSet(devicePrefix + key, text)) throw error('full', 'This device has no room to save more.')
        return true
      },
      'device.remove': function (a) {
        lsSet(devicePrefix + String(a.key), null)
        return true
      },
      'device.keys': function () {
        return lsKeys(devicePrefix)
      }
    }

    // ---------- the builder's stand-ins for account data and shared lists ----------
    function previewList(coll) {
      return readJson(localLists + coll, [])
    }
    var previewOps = {
      user: function () {
        return { signedIn: true, id: 'preview', name: 'You', maker: true, preview: true }
      },
      signIn: function () {
        return previewOps.user()
      },
      'data.get': function (a) {
        return readJson(localData + a.key, null)
      },
      'data.set': function (a) {
        lsSet(localData + a.key, JSON.stringify(a.value === undefined ? null : a.value))
        return true
      },
      'data.remove': function (a) {
        lsSet(localData + a.key, null)
        return true
      },
      'data.keys': function () {
        return lsKeys(localData)
      },
      'shared.list': function (a) {
        return previewList(a.collection).slice().reverse().slice(0, a.limit || 100)
      },
      'shared.add': function (a) {
        var list = previewList(a.collection)
        var id = list.reduce(function (m, r) {
          return Math.max(m, r.id)
        }, 0) + 1
        var now = new Date().toISOString()
        var rec = { id: id, data: a.data, by: 'preview', mine: true, createdAt: now, updatedAt: now }
        list.push(rec)
        lsSet(localLists + a.collection, JSON.stringify(list))
        return rec
      },
      'shared.update': function (a) {
        var list = previewList(a.collection).map(function (r) {
          return r.id === a.id ? Object.assign({}, r, { data: a.data, updatedAt: new Date().toISOString() }) : r
        })
        lsSet(localLists + a.collection, JSON.stringify(list))
        return true
      },
      'shared.remove': function (a) {
        lsSet(localLists + a.collection, JSON.stringify(previewList(a.collection).filter(function (r) {
          return r.id !== a.id
        })))
        return true
      }
    }

    // ---------- the shared app, through Mirg's servers ----------
    var liveOps = {
      user: function () {
        return remote({ action: 'me' })
      },
      signIn: function () {
        return needSignIn('Sign in to Mirg to use ' + title + ' with your account. The app never sees your email or password.').then(function () {
          return remote({ action: 'me' })
        })
      },
      'data.get': function (a) {
        return withSignIn('Sign in to Mirg to load what you saved in this app.', function () {
          return remote({ action: 'get', key: a.key }).then(function (d) {
            return d.value
          })
        })
      },
      'data.set': function (a) {
        return withSignIn('Sign in to Mirg to save this. It is kept in your Mirg account, so it is there on any device.', function () {
          return remote({ action: 'set', key: a.key, value: a.value }).then(function () {
            return true
          })
        })
      },
      'data.remove': function (a) {
        return withSignIn('Sign in to Mirg to change what you saved in this app.', function () {
          return remote({ action: 'remove', key: a.key }).then(function () {
            return true
          })
        })
      },
      'data.keys': function () {
        return withSignIn('Sign in to Mirg to load what you saved in this app.', function () {
          return remote({ action: 'keys' }).then(function (d) {
            return d.keys
          })
        })
      },
      'shared.list': function (a) {
        return remote({ action: 'list', collection: a.collection, limit: a.limit, before: a.before }).then(function (d) {
          return d.records
        })
      },
      'shared.add': function (a) {
        return withSignIn('Sign in to Mirg to add to this list. Others using the app see what you add, but never your email.', function () {
          return sharedConsent(a.collection).then(function () {
            return remote({ action: 'add', collection: a.collection, data: a.data })
          }).then(function (d) {
            var now = new Date().toISOString()
            return { id: d.id, data: a.data, by: d.by, mine: true, createdAt: now, updatedAt: now }
          })
        })
      },
      'shared.update': function (a) {
        return withSignIn('Sign in to Mirg to change this.', function () {
          return remote({ action: 'update', id: a.id, data: a.data }).then(function () {
            return true
          })
        })
      },
      'shared.remove': function (a) {
        return withSignIn('Sign in to Mirg to remove this.', function () {
          return remote({ action: 'delete', id: a.id }).then(function () {
            return true
          })
        })
      }
    }

    // ---------- AI, paid from the visitor's own Mirg tokens ----------
    var aiBusy = 0
    var TIER_RANK = { standard: 0, smart: 1, best: 2 }
    /** Asked before an app first uses AI, and again before it first uses a pricier model. */
    function aiConsent(tier) {
      var allowed = lsGet(aiAllowedKey)
      var had = allowed === 'yes' ? 0 : TIER_RANK[allowed] === undefined ? -1 : TIER_RANK[allowed]
      if (preview || had >= TIER_RANK[tier]) return Promise.resolve()
      var pricier = tier !== 'standard'
      return ask(
        pricier ? 'Let this app use a more powerful AI?' : 'Let this app use AI?',
        pricier
          ? 'This app uses a more powerful AI model, so each request uses more of your Mirg tokens than usual. Mirg limits how much one app can use in a day. You can stop at any time by closing the app.'
          : 'This app uses Mirg AI. Each request uses a small amount of your Mirg tokens. Mirg limits how much one app can use in a day. You can stop at any time by closing the app.',
        [
          { label: 'Not now', value: false },
          { label: 'Allow', value: true, primary: true }
        ],
        title
      ).then(function (yes) {
        if (!yes) throw error('ai_declined', 'AI was not allowed.')
        lsSet(aiAllowedKey, tier)
      })
    }

    // Which model answers. Apps may ask for a tier ('standard', the default; 'smart'; 'best') or a
    // model by name. Text, pictures and PDFs go to the chosen model; recordings, video and other
    // files go to the Gemini model of the same tier, since only Gemini reads audio and video.
    var AI_TIERS = {
      standard: { text: ['anthropic', 'claude-haiku-5-5'], media: ['gemini', 'gemini-3.5-flash-lite'] },
      smart: { text: ['anthropic', 'claude-sonnet-5-5'], media: ['gemini', 'gemini-4-hydrogen'] },
      best: { text: ['anthropic', 'claude-opus-5-5'], media: ['gemini', 'gemini-4-carbon'] }
    }
    var AI_MODELS = {
      'claude-haiku-5-5': ['anthropic', 'standard'],
      'claude-sonnet-5-5': ['anthropic', 'smart'],
      'claude-opus-5-5': ['anthropic', 'best'],
      'claude-fable-5-2': ['anthropic', 'best'],
      'gpt-6-luna': ['openai', 'standard'],
      'gpt-6.2-sol': ['openai', 'smart'],
      'gpt-6.2-astra': ['openai', 'best'],
      'gemini-3.5-flash-lite': ['gemini', 'standard'],
      'gemini-4-hydrogen': ['gemini', 'smart'],
      'gemini-4-argon': ['gemini', 'best'],
      'gemini-4-carbon': ['gemini', 'best']
    }
    // Dollars per million tokens (input, output), to keep each app within its daily allowance.
    var AI_PRICES = {
      'claude-haiku-5-5': [0.1, 0.5], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20], 'claude-fable-5-2': [8, 40],
      'gpt-6-luna': [0.1, 0.5], 'gpt-6.2-sol': [2, 10], 'gpt-6.2-astra': [8, 40],
      'gemini-3.5-flash-lite': [0.3, 2.5], 'gemini-4-hydrogen': [1.5, 7.5], 'gemini-4-argon': [4, 20], 'gemini-4-carbon': [4, 20]
    }
    function pickModel(a) {
      var want = a.model === undefined || a.model === null || a.model === '' ? 'standard' : String(a.model)
      var tier, chosen
      if (AI_TIERS[want]) {
        tier = want
        chosen = AI_TIERS[want].text
      } else if (AI_MODELS[want]) {
        tier = AI_MODELS[want][1]
        chosen = [AI_MODELS[want][0], want]
      } else {
        throw error('ai_model', 'Mirg does not offer "' + want + '" inside apps. Use "standard", "smart", "best" or one of: ' + Object.keys(AI_MODELS).join(', ') + '.')
      }
      var type = a.file ? String(a.file.type || '') : ''
      var readable = !a.file || /^image\/(png|jpeg|gif|webp)$/.test(type) || type === 'application/pdf'
      if (!readable && chosen[0] !== 'gemini') chosen = AI_TIERS[tier].media
      return { tier: tier, provider: chosen[0], model: chosen[1] }
    }

    var SYSTEM_BASE = 'You are an AI feature inside an app someone made with Mirg, used by a member of the public. Be helpful and safe; do not ask for passwords or payment details.'
    function requestFor(pick, a, prompt, data) {
      var system = String(a.system || '').slice(0, 8000)
      system = SYSTEM_BASE + (system ? '\n\nThe app\'s instructions:\n' + system : '') + (a.json ? '\n\nAnswer with only valid JSON: no other text and no code fences.' : '')
      var max = Math.min(Math.max(Number(a.maxTokens) || 2048, 64), AI_MAX_OUTPUT)
      var type = a.file ? a.file.type || 'application/octet-stream' : ''
      if (pick.provider === 'anthropic') {
        var content = []
        if (data !== null) content.push(type === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: type, data: data } } : { type: 'image', source: { type: 'base64', media_type: type, data: data } })
        if (prompt.trim()) content.push({ type: 'text', text: prompt })
        var body = { model: pick.model, max_tokens: max, system: system, messages: [{ role: 'user', content: content }] }
        // Short answers inside an app: as little thinking as each model allows.
        if (pick.model === 'claude-haiku-5-5') {
          body.thinking = { type: 'disabled' }
          body.output_config = { effort: 'low' }
        } else body.output_config = { effort: 'low' }
        return { path: '/proxy/anthropic/v1/messages', headers: { 'anthropic-version': '2023-06-01' }, body: body }
      }
      if (pick.provider === 'openai') {
        var input = []
        if (data !== null) input.push(type === 'application/pdf' ? { type: 'input_file', filename: a.file.name || 'file.pdf', file_data: 'data:' + type + ';base64,' + data } : { type: 'input_image', image_url: 'data:' + type + ';base64,' + data })
        if (prompt.trim()) input.push({ type: 'input_text', text: prompt })
        var req = { model: pick.model, instructions: system, input: [{ role: 'user', content: input }], max_output_tokens: max, reasoning: { effort: 'low' } }
        if (a.json) req.text = { format: { type: 'json_object' } }
        return { path: '/proxy/openai/v1/responses', headers: {}, body: req }
      }
      var parts = []
      if (data !== null) parts.push({ inline_data: { mime_type: type, data: data } })
      if (prompt.trim()) parts.push({ text: prompt })
      return {
        path: '/proxy/gemini/v1beta/models/' + pick.model + ':generateContent',
        headers: {},
        body: {
          contents: [{ role: 'user', parts: parts }],
          systemInstruction: { parts: [{ text: system }] },
          generationConfig: Object.assign({ maxOutputTokens: max }, a.json ? { responseMimeType: 'application/json' } : {})
        }
      }
    }
    /** The answer's text and how many tokens it used, from any of the three providers. */
    function readAnswer(provider, d) {
      if (provider === 'anthropic') {
        if (d.stop_reason === 'refusal') return { blocked: true }
        return {
          text: (d.content || []).filter(function (b) { return b.type === 'text' }).map(function (b) { return b.text }).join(''),
          input: (d.usage && (d.usage.input_tokens || 0) + (d.usage.cache_creation_input_tokens || 0) + (d.usage.cache_read_input_tokens || 0)) || 0,
          output: (d.usage && d.usage.output_tokens) || 0
        }
      }
      if (provider === 'openai') {
        var text = ''
        ;(d.output || []).forEach(function (o) {
          ;(o.content || []).forEach(function (c) {
            if (c.type === 'output_text') text += c.text
          })
        })
        return { text: text, input: (d.usage && d.usage.input_tokens) || 0, output: (d.usage && d.usage.output_tokens) || 0 }
      }
      var c = d.candidates && d.candidates[0]
      var said = ((c && c.content && c.content.parts) || []).map(function (p) { return p.thought ? '' : p.text || '' }).join('')
      var u = d.usageMetadata || {}
      return { text: said, blocked: !said && c && c.finishReason && c.finishReason !== 'STOP', input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) }
    }
    function parseJson(text) {
      var t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      return JSON.parse(t)
    }

    function askAi(a) {
      var prompt = String(a.prompt || '')
      if (!prompt.trim() && !a.file) throw error('ai_empty', 'There is nothing to ask.')
      if (prompt.length > AI_MAX_PROMPT) throw error('ai_too_long', 'That is too much text to ask about at once.')
      if (a.file && !(a.file instanceof Blob)) throw error('ai_file', 'Send a recording, picture or file as a Blob.')
      if (a.file && a.file.size > AI_MAX_FILE) throw error('ai_file', 'That file is too big to ask about (15 MB at most).')
      if (aiBusy >= 3) throw error('ai_busy', 'Wait for the last answers before asking more.')
      var pick = pickModel(a)
      // Limits per app per day on this device, kept by Mirg's page (an app cannot change them), so an
      // app cannot keep spending someone's tokens after they allowed it once: a number of requests,
      // and an amount of Mirg tokens (a few requests on the most powerful models use it up).
      var today = new Date().toISOString().slice(0, 10)
      var used = readJson(aiDayKey, { day: today, n: 0, tokens: 0 })
      if (used.day !== today) used = { day: today, n: 0, tokens: 0 }
      if (!preview && (used.n >= AI_PER_APP_PER_DAY || (used.tokens || 0) >= AI_TOKENS_PER_APP_PER_DAY)) throw error('ai_daily_limit', 'This app has used as much AI as Mirg allows in a day. Try again tomorrow.')
      var why = 'Sign in to Mirg to use this app\'s AI features. It uses your Mirg tokens; the app never sees your email.'
      return (preview ? Promise.resolve() : needSignIn(why))
        .then(function () {
          return aiConsent(pick.tier)
        })
        .then(function () {
          return Promise.all([token(), a.file ? base64(a.file) : Promise.resolve(null)])
        })
        .then(function (got) {
          var t = got[0]
          if (!t) throw error('sign_in', 'Sign in to Mirg first.')
          var req = requestFor(pick, a, prompt, got[1])
          aiBusy++
          var note = function (input, output) {
            if (preview) return
            var price = AI_PRICES[pick.model] || [4, 20]
            var count = readJson(aiDayKey, { day: today, n: 0, tokens: 0 })
            if (count.day !== today) count = { day: today, n: 0, tokens: 0 }
            count.n++
            // Mirg tokens: 125,000 to a dollar of AI cost.
            count.tokens = (count.tokens || 0) + Math.ceil(((input * price[0] + output * price[1]) / 1e6) * 125000)
            lsSet(aiDayKey, JSON.stringify(count))
          }
          return fetch(API + req.path, {
            method: 'POST',
            headers: Object.assign({ authorization: 'Bearer ' + t, 'x-mirg-device': device(), 'x-mirg-client': 'web-other', 'content-type': 'application/json' }, req.headers),
            body: JSON.stringify(req.body)
          })
            .catch(function () {
              throw error('offline', 'Mirg could not be reached. Check the connection.')
            })
            .then(function (r) {
              return r.json().catch(function () {
                return {}
              }).then(function (d) {
                if (!r.ok) {
                  var msg = (d.error && d.error.message) || 'The AI did not answer. Try again.'
                  if (r.status === 402 || /free plan|add credits|upgrade/i.test(msg)) {
                    ask('Out of Mirg tokens', 'You have used the Mirg tokens this needs. Add credits or upgrade at mirg.ai/pricing to keep using AI in apps.', [{ label: 'OK', value: true, primary: true }], title)
                    throw error('limit', msg)
                  }
                  throw error('ai_error', msg)
                }
                var out = readAnswer(pick.provider, d)
                note(out.input || 0, out.output || 0)
                if (out.blocked) throw error('ai_blocked', 'The AI would not answer that.')
                if (a.json) {
                  try {
                    return parseJson(out.text)
                  } catch (e) {
                    throw error('ai_json', 'The AI did not answer in the expected format. Try again.')
                  }
                }
                return out.text
              })
            })
            .finally(function () {
              aiBusy--
            })
        })
    }

    /** A link the app wants to open: Mirg shows where it goes, and opens it only if the person says so. */
    function openLink(a) {
      var u
      try {
        u = new URL(String(a.url || ''))
      } catch (x) {
        throw error('open_bad', 'That is not a link.')
      }
      if (!/^(https?|mailto|tel):$/.test(u.protocol)) throw error('open_bad', 'Apps can open web, email and phone links.')
      var where = u.protocol === 'mailto:' ? 'an email to ' + decodeURIComponent(u.pathname) : u.protocol === 'tel:' ? 'a call to ' + decodeURIComponent(u.pathname) : u.hostname
      var full = u.href.length > 140 ? u.href.slice(0, 140) + '…' : u.href
      return ask(
        title + ' wants to open ' + where,
        'This goes outside Mirg. Only continue if you trust it, and never type a password or card number on a page an app sent you to.',
        [
          { label: 'Cancel', value: false },
          { label: 'Open', value: true, primary: true, open: u.href }
        ],
        full
      ).then(function (go) {
        if (!go) throw error('open_cancelled', 'The link was not opened.')
        return true
      })
    }

    var ops = Object.assign({}, deviceOps, preview ? previewOps : liveOps, { 'ai.ask': askAi, open: openLink })

    function onMessage(e) {
      if (!frame.contentWindow || e.source !== frame.contentWindow) return
      // A shared app answers only while its frame shows the app's own address: an app that sends its
      // frame to another site leaves that site nothing to ask for. (The builder's preview has no origin.)
      if (!preview && e.origin !== opts.origin) return
      // Answers go only to the address the app is shown from.
      var replyTo = opts.origin || (preview ? '*' : 'https://play.mirg.ai')
      var d = e.data
      if (!d || d.mirg !== 'app' || typeof d.op !== 'string') return
      var reply = function (ok, value) {
        try {
          frame.contentWindow.postMessage({ mirg: 'app-reply', id: d.id, ok: ok, value: ok ? value : { code: value.code || 'error', message: value.message || String(value) } }, replyTo)
        } catch (x) {}
      }
      if (d.op === 'hello') return reply(true, { host: 'mirg', preview: preview, signedIn: preview || Boolean(session()), links: true })
      var fn = ops[d.op]
      if (!fn) return reply(false, error('unknown', 'Mirg does not know "' + d.op + '".'))
      var args = d.args && typeof d.args === 'object' ? d.args : {}
      try {
        Promise.resolve(fn(args)).then(
          function (v) {
            reply(true, v === undefined ? null : v)
          },
          function (err) {
            reply(false, err)
          }
        )
      } catch (err) {
        reply(false, err)
      }
    }
    window.addEventListener('message', onMessage)
    return {
      detach: function () {
        window.removeEventListener('message', onMessage)
      }
    }
  }

  // ---------- devices an app asks for ----------

  var PERMISSION_NAMES = { microphone: 'your microphone', camera: 'your camera', geolocation: 'your location' }
  /** The frame's allow list for an app given these permissions. */
  function allowFor(permissions) {
    var list = ['fullscreen', 'autoplay', 'clipboard-write']
    ;(permissions || []).forEach(function (p) {
      if (PERMISSION_NAMES[p]) list.push(p)
    })
    return list.join('; ')
  }
  /** Ask the visitor before an app may ask the browser for its devices. Resolves with what they allowed. */
  function askPermissions(slug, title, permissions) {
    var wanted = (permissions || []).filter(function (p) {
      return PERMISSION_NAMES[p]
    })
    if (!wanted.length) return Promise.resolve([])
    var key = 'mirg-app-allowed:' + slug
    if (lsGet(key) === wanted.join(',')) return Promise.resolve(wanted)
    var names = wanted.map(function (p) {
      return PERMISSION_NAMES[p]
    })
    var list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0]
    return ask(
      title + ' wants to use ' + list,
      'This app was made by someone on Mirg. If you allow it, your browser will ask you too. Only allow apps you trust.',
      [
        { label: 'Not now', value: false },
        { label: 'Allow', value: true, primary: true }
      ]
    ).then(function (yes) {
      if (!yes) return []
      lsSet(key, wanted.join(','))
      return wanted
    })
  }

  /**
   * Each shared app has its own address, <20 letters>-app.mirg.ai, so the browser keeps every app's
   * storage apart from every other app's and from the games on play.mirg.ai. The letters come from
   * the app's link name; play.mirg.ai's worker checks them the same way.
   */
  function originFor(slug) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode('mirg-app|' + slug)).then(function (buf) {
      var hex = Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2) }).join('')
      return 'https://' + hex.slice(0, 20) + '-app.mirg.ai'
    })
  }

  window.MirgAppHost = { attach: attach, allowFor: allowFor, askPermissions: askPermissions, ask: ask, originFor: originFor }
})()
