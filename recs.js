// Game suggestions: notes what this browser plays (under the random id site.js keeps for it, never a
// name or email) and shows suggested games from Mirg's database (recommend_games). Used for the
// "For you" row on the home page and "Play next" under each game.
;(function () {
  var RPC = 'https://dlnmbeqdtpyjkprkxfvt.supabase.co/rest/v1/rpc/'
  var KEY = 'sb_publishable_RTQ8CSTfuHByAw1-_bbqag_NX0-kQhp'
  var PLAY_HOST = 'https://play.mirg.ai'

  // The same id site.js makes; made here too in case this page loaded before it did.
  function visitor() {
    try {
      var v = localStorage.getItem('mirg-visitor')
      if (!/^[a-z0-9]{8,40}$/.test(v || '')) {
        v = (Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^a-z0-9]/g, '').slice(0, 24)
        localStorage.setItem('mirg-visitor', v)
      }
      return v
    } catch (e) {
      return null
    }
  }
  // Signed in to the web builder in this browser: its sign-in goes along, so the suggestions can use
  // the types of game this person makes (and leave out their own games). Only while it is still valid.
  function signIn() {
    try {
      var s = JSON.parse(localStorage.getItem('mirg-web-session') || 'null')
      return s && s.accessToken && s.expiresAt > Date.now() + 60000 ? s.accessToken : null
    } catch (e) {
      return null
    }
  }
  function rpc(fn, body, withSignIn) {
    var token = (withSignIn && signIn()) || KEY
    return fetch(RPC + fn, {
      method: 'POST',
      headers: { apikey: KEY, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  }
  // Before suggestions began, the play page already marked each game this browser opened (to count a
  // play once a day). Those marks are sent once, as play history, so a returning visitor's first
  // suggestions already know what they played.
  function importEarlierPlays() {
    var v = visitor()
    try {
      if (!v || localStorage.getItem('mirg-recs-imported')) return Promise.resolve()
      var slugs = []
      for (var i = 0; i < localStorage.length; i++) {
        var m = /^mirg-played-([a-z0-9-]{3,64})$/.exec(localStorage.key(i) || '')
        if (m) slugs.push(m[1])
      }
      localStorage.setItem('mirg-recs-imported', '1')
      return Promise.all(
        slugs.slice(0, 50).map(function (slug) {
          return rpc('note_play', { p_visitor: v, game: slug, p_seconds: 0, p_from: null }).catch(function () {})
        })
      )
    } catch (e) {
      return Promise.resolve()
    }
  }
  function card(g) {
    var box = document.createElement('div')
    box.className = 'game-card'
    var a = document.createElement('a')
    a.className = 'game-open'
    // from=rec: the play page notes that this play came from a suggestion.
    a.href = '/play?g=' + encodeURIComponent(g.slug) + '&from=rec'
    var pic = document.createElement('div')
    pic.className = 'game-thumb'
    var img = document.createElement('img')
    img.alt = ''
    img.loading = 'lazy'
    img.src = PLAY_HOST + '/' + g.slug + '/mirg-thumb.jpg'
    img.onerror = function () {
      img.remove()
      pic.classList.add('none')
      pic.insertBefore(document.createTextNode(g.title), pic.firstChild)
    }
    pic.appendChild(img)
    if (g.category && g.category !== 'Other') {
      var type = document.createElement('span')
      type.className = 'game-type'
      type.textContent = g.category
      pic.appendChild(type)
    }
    var name = document.createElement('div')
    name.className = 'game-name'
    var title = document.createElement('span')
    title.className = 'game-title'
    title.textContent = g.title
    name.appendChild(title)
    // The play count, as on the other game cards: "▶ 120".
    var n = Number(g.plays) || 0
    var plays = document.createElement('span')
    plays.className = 'game-plays'
    plays.setAttribute('aria-label', n === 1 ? '1 play' : n.toLocaleString() + ' plays')
    plays.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 1.8v8.4a.6.6 0 0 0 .9.5l6.6-4.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5Z" fill="currentColor"/></svg>'
    plays.appendChild(document.createTextNode(n.toLocaleString()))
    name.appendChild(plays)
    var why = document.createElement('div')
    why.className = 'game-why'
    why.textContent = g.reason
    a.appendChild(pic)
    a.appendChild(name)
    a.appendChild(why)
    box.appendChild(a)
    return box
  }

  // Previewing the site on this computer before the database has recommend_games: real games with
  // sample reasons, so the rows can be looked at. Never on mirg.ai.
  var LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  function sample(opts) {
    return fetch('https://dlnmbeqdtpyjkprkxfvt.supabase.co/rest/v1/public_games?select=slug,title,category,plays,handle&order=plays.desc&limit=40', {
      headers: { apikey: KEY, authorization: 'Bearer ' + KEY }
    })
      .then(function (r) {
        return r.ok ? r.json() : []
      })
      .then(function (games) {
        var reasons = opts.current
          ? ['Players of this game also played', 'Like this game', 'Popular today', 'New']
          : ['Because you play Arcade games', 'Updated since you played', 'More from @', 'New']
        return games
          .filter(function (g) {
            return g.slug !== opts.current
          })
          .slice(3, 3 + (opts.count || 4))
          .map(function (g, i) {
            var why = reasons[i % reasons.length]
            g.reason = why === 'More from @' ? (g.handle ? why + g.handle : 'Popular today') : why
            g.personal = true
            return g
          })
      })
  }

  window.mirgRecs = {
    /** Note a play of `game`: 0 seconds when it opens, then the seconds since the last note. */
    note: function (game, seconds, from) {
      var v = visitor()
      if (!v) return
      rpc('note_play', { p_visitor: v, game: game, p_seconds: seconds || 0, p_from: from || null }).catch(function () {})
    },
    /**
     * Fill opts.list with suggestions and show opts.box. opts.current: the game being played.
     * opts.personalOnly: show nothing to a visitor who has not played anything yet.
     * Resolves to whether anything was shown.
     */
    show: function (opts) {
      return importEarlierPlays()
        .then(function () {
          var body = { p_visitor: visitor() || '', p_current: opts.current || null, p_phone: matchMedia('(pointer: coarse)').matches, max_count: opts.count || 4 }
          // An expired or refused sign-in falls back to asking without it.
          return rpc('recommend_games', body, true).then(function (r) {
            return r.status === 401 ? rpc('recommend_games', body) : r
          })
        })
        .then(function (r) {
          if (!r.ok) return LOCAL ? sample(opts) : []
          return r.json().then(function (rows) {
            // On this computer, a browser with no plays here still sees the rows, to preview them.
            return LOCAL && opts.personalOnly && !(rows[0] && rows[0].personal) ? sample(opts) : rows
          })
        })
        .then(function (rows) {
          if (!rows.length || (opts.personalOnly && !rows[0].personal)) return false
          opts.list.textContent = ''
          rows.forEach(function (g) {
            opts.list.appendChild(card(g))
          })
          opts.box.hidden = false
          return true
        })
        .catch(function () {
          return false
        })
    }
  }
})()
