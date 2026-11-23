// The creator stats page (mirg.ai/stats): how each game and app this account shares is doing. Uses the
// sign-in the web builder keeps in this browser, and reads GET /stats and POST /suggestions from the
// Mirg account API.
//
//   - an overview at the top, like YouTube Studio's: a tab for each important number over the last
//     28 days, with the change from the 28 days before; the chosen tab's numbers are drawn below it
//   - ideas from players: suggestions drawn from comments, each to fix in the builder or dismiss
//   - a card per game or app, with its numbers and plays over the last 30 days
;(function () {
  var SUPABASE = 'https://dlnmbeqdtpyjkprkxfvt.supabase.co'
  var KEY = 'sb_publishable_RTQ8CSTfuHByAw1-_bbqag_NX0-kQhp'
  var SESSION_KEY = 'mirg-web-session'
  var PLAY_HOST = 'https://play.mirg.ai'
  var NS = 'http://www.w3.org/2000/svg'
  var $ = function (id) {
    return document.getElementById(id)
  }

  function session() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')
    } catch (e) {
      return null
    }
  }
  // A valid sign-in, refreshed if it is about to run out; null when there is none.
  function token() {
    var s = session()
    if (!s || !s.accessToken) return Promise.resolve(null)
    if (s.expiresAt - Date.now() > 60000) return Promise.resolve(s.accessToken)
    return fetch(SUPABASE + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refreshToken })
    })
      .then(function (r) {
        return r.ok ? r.json() : null
      })
      .then(function (d) {
        if (!d || !d.access_token) return null
        var next = { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: Date.now() + (d.expires_in || 3600) * 1000, email: (d.user && d.user.email) || s.email }
        try {
          localStorage.setItem(SESSION_KEY, JSON.stringify(next))
        } catch (e) {}
        return next.accessToken
      })
      .catch(function () {
        return null
      })
  }
  function api(t, method, path, body) {
    return fetch(SUPABASE + '/functions/v1/api' + path, {
      method: method,
      headers: Object.assign({ authorization: 'Bearer ' + t }, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().then(function (out) {
        if (!r.ok) {
          var e = new Error((out.error && out.error.message) || 'The stats could not load.')
          e.status = r.status
          throw e
        }
        return out
      })
    })
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }
  function svgEl(tag, attrs) {
    var e = document.createElementNS(NS, tag)
    for (var k in attrs) e.setAttribute(k, attrs[k])
    return e
  }
  function n(v) {
    return (Number(v) || 0).toLocaleString()
  }
  function playTime(seconds) {
    var s = Math.round(Number(seconds) || 0)
    if (!s) return '–'
    if (s < 60) return s + 's'
    var m = Math.floor(s / 60)
    if (m < 60) return m + 'm ' + (s % 60) + 's'
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'
  }
  function day(text) {
    return new Date(text + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  function sum(list, key) {
    return list.reduce(function (a, d) {
      return a + (Number(d[key]) || 0)
    }, 0)
  }
  /** A round top for the chart's scale (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 times a power of ten), at least the highest value. */
  function niceMax(v) {
    if (v <= 4) return Math.max(1, Math.ceil(v))
    var p = Math.pow(10, Math.floor(Math.log10(v)))
    var steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
    for (var i = 0; i < steps.length; i++) if (steps[i] * p >= v) return steps[i] * p
    return 10 * p
  }

  /**
   * A line chart of one number a day. points: [{ day, value }], oldest first. A 2px line over a light
   * fill, a gridline at the top of the scale and one at zero; hovering (or tapping) anywhere shows the
   * nearest day with a dot on the line and the day's value.
   */
  function lineChart(points, opts) {
    var W = 600
    var H = opts.height
    var max = niceMax(Math.max.apply(null, points.map(function (p) { return p.value })))
    var box = el('div', 'stats-line' + (opts.big ? ' big' : ''))
    box.style.height = H + 'px'
    var x = function (i) {
      return points.length === 1 ? W / 2 : (i / (points.length - 1)) * W
    }
    var y = function (v) {
      return H - 2 - (v / max) * (H - 8)
    }
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', role: 'img', 'aria-label': opts.label + ': ' + n(sum(points, 'value')) + ' in all' })
    svg.appendChild(svgEl('line', { x1: 0, x2: W, y1: y(max), y2: y(max), class: 'stats-line-grid' }))
    svg.appendChild(svgEl('line', { x1: 0, x2: W, y1: H - 1.5, y2: H - 1.5, class: 'stats-line-base' }))
    var d = points
      .map(function (p, i) {
        return (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(p.value).toFixed(1)
      })
      .join('')
    svg.appendChild(svgEl('path', { d: d + 'L' + W + ',' + (H - 1.5) + 'L0,' + (H - 1.5) + 'Z', class: 'stats-line-area' }))
    svg.appendChild(svgEl('path', { d: d, class: 'stats-line-path' }))
    var cross = svgEl('line', { x1: 0, x2: 0, y1: 0, y2: H, class: 'stats-line-cross' })
    cross.style.display = 'none'
    svg.appendChild(cross)
    box.appendChild(svg)
    // The top of the scale, written at the gridline.
    var top = el('span', 'stats-line-max', n(max))
    top.style.top = y(max) + 'px'
    box.appendChild(top)
    // The dot is drawn in HTML so it stays round when the chart stretches.
    var dot = el('span', 'stats-line-dot')
    dot.hidden = true
    box.appendChild(dot)
    var tip = el('div', 'stats-line-tip')
    tip.hidden = true
    box.appendChild(tip)
    var pick = function (clientX) {
      var r = svg.getBoundingClientRect()
      var i = Math.round(((clientX - r.left) / r.width) * (points.length - 1))
      i = Math.max(0, Math.min(points.length - 1, i))
      var p = points[i]
      var left = (x(i) / W) * 100
      cross.setAttribute('x1', x(i))
      cross.setAttribute('x2', x(i))
      cross.style.display = ''
      dot.style.left = left + '%'
      dot.style.top = y(p.value) + 'px'
      dot.hidden = false
      tip.textContent = ''
      tip.appendChild(el('strong', '', n(p.value) + ' ' + (p.value === 1 ? opts.one : opts.many)))
      tip.appendChild(el('span', '', day(p.day)))
      tip.style.left = Math.max(8, Math.min(92, left)) + '%'
      tip.hidden = false
    }
    var hide = function () {
      cross.style.display = 'none'
      dot.hidden = true
      tip.hidden = true
    }
    box.addEventListener('pointermove', function (e) {
      pick(e.clientX)
    })
    box.addEventListener('pointerdown', function (e) {
      pick(e.clientX)
    })
    box.addEventListener('pointerleave', hide)
    var wrap = el('div', 'stats-line-wrap')
    wrap.appendChild(box)
    var axis = el('div', 'stats-chart-axis')
    axis.appendChild(el('span', '', day(points[0].day)))
    axis.appendChild(el('span', '', 'Today'))
    wrap.appendChild(axis)
    return wrap
  }

  // ---------- the overview at the top ----------

  var METRICS = [
    { key: 'plays', label: 'Plays', one: 'play', many: 'plays', hint: 'Every time someone opened one of them, once a day per device' },
    { key: 'players', label: 'New players', one: 'new player', many: 'new players', hint: 'People who opened one of them on mirg.ai for the first time' },
    { key: 'comments', label: 'Comments', one: 'comment', many: 'comments', hint: 'Comments people left under them' }
  ]
  var chosen = 'plays'

  function change(now, before) {
    if (!before) return now ? { text: 'New', more: ' in the last 28 days', dir: 'up' } : { text: 'None', more: ' in the 28 days before either', dir: 'same' }
    var pct = Math.round(((now - before) / before) * 100)
    if (pct === 0) return { text: 'Same', more: ' as the 28 days before', dir: 'same' }
    return { text: (pct > 0 ? '▲ ' : '▼ ') + Math.abs(pct) + '%', more: ' from the 28 days before', dir: pct > 0 ? 'up' : 'down' }
  }

  function overview(daily) {
    var box = $('stats-overview')
    box.textContent = ''
    if (!daily || daily.length < 2) {
      box.hidden = true
      return
    }
    var recent = daily.slice(-28)
    var before = daily.slice(0, Math.max(0, daily.length - 28))
    var tabs = el('div', 'stats-tabs')
    tabs.setAttribute('role', 'tablist')
    var panel = el('div', 'stats-tab-panel')
    panel.setAttribute('role', 'tabpanel')
    var draw = function () {
      tabs.textContent = ''
      METRICS.forEach(function (m) {
        var now = sum(recent, m.key)
        var c = change(now, sum(before, m.key))
        var tab = el('button', 'stats-tab' + (m.key === chosen ? ' on' : ''))
        tab.type = 'button'
        tab.setAttribute('role', 'tab')
        tab.setAttribute('aria-selected', String(m.key === chosen))
        tab.title = m.hint
        tab.appendChild(el('span', 'stats-tab-label', m.label))
        tab.appendChild(el('span', 'stats-tab-value', n(now)))
        var ch = el('span', 'stats-tab-change ' + c.dir, c.text)
        ch.appendChild(el('span', 'stats-tab-more', c.more))
        tab.appendChild(ch)
        tab.onclick = function () {
          chosen = m.key
          draw()
        }
        tabs.appendChild(tab)
      })
      var m = METRICS.filter(function (x) {
        return x.key === chosen
      })[0]
      panel.textContent = ''
      panel.appendChild(
        lineChart(
          recent.map(function (d) {
            return { day: String(d.day).slice(0, 10), value: Number(d[m.key]) || 0 }
          }),
          { height: 200, big: true, label: m.label + ' per day, last 28 days', one: m.one, many: m.many }
        )
      )
    }
    draw()
    var head = el('div', 'stats-overview-head')
    head.appendChild(el('h2', '', 'Last 28 days'))
    head.appendChild(el('span', 'fine', 'All your games and apps'))
    box.appendChild(head)
    box.appendChild(tabs)
    box.appendChild(panel)
    box.hidden = false
  }

  // ---------- ideas from players ----------

  function ideas(t, list) {
    var box = $('stats-ideas')
    box.textContent = ''
    if (!list.length) {
      box.hidden = true
      return
    }
    var head = el('div', 'stats-ideas-head')
    head.appendChild(el('h2', '', 'Ideas from players'))
    head.appendChild(el('span', 'fine', 'Drawn from comments. Fix it opens the builder and asks Mirg to make the change, which uses your plan.'))
    box.appendChild(head)
    var ul = el('ul', 'stats-ideas-list')
    list.forEach(function (s) {
      var li = el('li', 'stats-idea')
      var text = el('div', 'stats-idea-text')
      text.appendChild(el('span', 'stats-idea-body', s.body))
      text.appendChild(el('span', 'stats-idea-from', (s.title || s.slug) + ' · ' + s.comments + (s.comments === 1 ? ' player' : ' players')))
      var dismiss = el('button', 'linklike', 'Dismiss')
      dismiss.type = 'button'
      dismiss.setAttribute('aria-label', 'Dismiss: ' + s.body)
      dismiss.onclick = function () {
        li.remove()
        if (!ul.children.length) box.hidden = true
        api(t, 'POST', '/suggestions/resolve', { id: s.id, status: 'dismissed' }).catch(function () {})
      }
      var fix = el('a', 'btn small primary', 'Fix it')
      fix.href = '/create?fix=' + encodeURIComponent(s.id) + '&slug=' + encodeURIComponent(s.slug)
      fix.setAttribute('aria-label', 'Fix it in the builder: ' + s.body)
      li.appendChild(text)
      li.appendChild(dismiss)
      li.appendChild(fix)
      ul.appendChild(li)
    })
    box.appendChild(ul)
    box.hidden = false
  }

  // ---------- a card per game or app ----------

  function gameCard(g) {
    var app = g.kind === 'app'
    var card = el('article', 'stats-game')
    var head = el('div', 'stats-game-head')
    var pic = el('a', 'stats-game-pic')
    pic.href = '/play?g=' + encodeURIComponent(g.slug)
    var img = new Image()
    img.alt = ''
    img.loading = 'lazy'
    img.src = PLAY_HOST + '/' + g.slug + '/mirg-thumb.jpg'
    img.onerror = function () {
      img.remove()
    }
    pic.appendChild(img)
    head.appendChild(pic)
    var names = el('div', 'stats-game-names')
    var title = el('a', 'stats-game-title', g.title || g.slug)
    title.href = '/play?g=' + encodeURIComponent(g.slug)
    names.appendChild(title)
    var where = g.hidden ? 'Hidden after reports' : g.listed ? 'On mirg.ai' : 'Shared by link only'
    names.appendChild(el('div', 'stats-game-where' + (g.hidden ? ' bad' : ''), (app ? 'App · ' : 'Game · ') + where + (g.category && g.category !== 'Other' ? ' · ' + g.category : '') + (g.phone ? ' · Phones' : '')))
    head.appendChild(names)
    card.appendChild(head)

    var nums = el('dl', 'stats-game-nums')
    function add(label, value, hint) {
      var row = el('div')
      if (hint) row.title = hint
      row.appendChild(el('dt', '', label))
      row.appendChild(el('dd', '', value))
      nums.appendChild(row)
    }
    add(app ? 'Opens' : 'Plays', n(g.plays), 'Every time someone opened it, once a day per device')
    add('Last 7 days', n(g.plays_7d))
    add('Last 24 hours', n(g.plays_24h))
    add(app ? 'People' : 'Players', n(g.players), app ? 'Different people who used it on mirg.ai' : 'Different people who played it on mirg.ai')
    add('Came back', n(g.returning_players), app ? 'People who used it again on another day' : 'Players who played it again on another day')
    add(app ? 'Avg. time' : 'Avg. play time', playTime(g.avg_seconds), 'On computers. Phones open games on their own page, so their time is not known')
    add('From suggestions', n(g.from_suggestions), 'People who found it in For you or Play next')
    add('Comments', n(g.comments))
    if (g.leaderboard_players) add('On the leaderboard', n(g.leaderboard_players))
    card.appendChild(nums)
    if (g.by_day && g.by_day.length > 1) {
      card.appendChild(el('div', 'stats-chart-title', (app ? 'Opens' : 'Plays') + ', last 30 days'))
      card.appendChild(
        lineChart(
          g.by_day.map(function (d) {
            return { day: String(d.day).slice(0, 10), value: Number(d.plays) || 0 }
          }),
          { height: 72, label: (app ? 'Opens' : 'Plays') + ' per day for the last 30 days', one: app ? 'open' : 'play', many: app ? 'opens' : 'plays' }
        )
      )
    }
    return card
  }

  function show(data) {
    var t = data.totals || {}
    var tiles = $('stats-tiles')
    tiles.textContent = ''
    var tile = function (label, value, hint) {
      var x = el('div', 'stats-tile')
      x.appendChild(el('div', 'stats-tile-value', value))
      x.appendChild(el('div', 'stats-tile-label', label))
      if (hint) x.title = hint
      return x
    }
    tiles.appendChild(tile('Plays, all time', n(t.plays)))
    tiles.appendChild(tile('Last 7 days', n(t.plays_7d)))
    tiles.appendChild(tile('Last 24 hours', n(t.plays_24h)))
    tiles.appendChild(tile('Players', n(t.players), 'Different people who opened your games and apps on mirg.ai'))
    tiles.appendChild(tile('Comments', n(t.comments)))
    tiles.hidden = false
    var games = data.games || []
    overview(games.length ? data.daily : null)
    $('stats-sub').textContent = games.length === 1 ? 'The 1 thing you shared.' : 'The ' + games.length + ' things you shared, most opened first.'
    $('stats-note').textContent =
      'Players, play time and suggestions are counted from November 13, 2026' +
      (data.days_since ? '; plays per day from ' + new Date(data.days_since + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : '') +
      '. Total plays go back to when each one was shared.'
    $('stats-note').hidden = false
    var list = $('stats-games')
    list.textContent = ''
    games.forEach(function (g) {
      list.appendChild(gameCard(g))
    })
    $('stats-empty').hidden = games.length > 0
  }

  token().then(function (t) {
    if (!t) {
      $('stats-signin').hidden = false
      return
    }
    return api(t, 'GET', '/stats')
      .then(function (body) {
        show(body)
        // Ideas from players come after the numbers; the page works without them.
        if ((body.games || []).length) {
          api(t, 'POST', '/suggestions', {})
            .then(function (out) {
              ideas(t, out.suggestions || [])
            })
            .catch(function () {})
        }
      })
      .catch(function (e) {
        if (e && e.status === 401) {
          $('stats-signin').hidden = false
          return
        }
        $('stats-error').textContent = (e && e.message) || 'The stats could not load. Refresh the page to try again.'
        $('stats-error').hidden = false
      })
  })
})()
