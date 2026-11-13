// The creator stats page (mirg.ai/stats): how each game this account shares is doing. Uses the
// sign-in the web builder keeps in this browser, and reads GET /stats from the Mirg account API.
;(function () {
  var SUPABASE = 'https://dlnmbeqdtpyjkprkxfvt.supabase.co'
  var KEY = 'sb_publishable_RTQ8CSTfuHByAw1-_bbqag_NX0-kQhp'
  var SESSION_KEY = 'mirg-web-session'
  var PLAY_HOST = 'https://play.mirg.ai'
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

  function el(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
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

  function tile(label, value, hint) {
    var t = el('div', 'stats-tile')
    t.appendChild(el('div', 'stats-tile-value', value))
    t.appendChild(el('div', 'stats-tile-label', label))
    if (hint) t.title = hint
    return t
  }

  // Plays per day for the last 30 days: one bar a day, the tallest day reaching the top. Hovering a
  // bar (or tapping it) shows the day and its plays.
  function chart(days) {
    var W = 300
    var H = 64
    var gap = 2
    var bw = (W - gap * (days.length - 1)) / days.length
    var max = Math.max(1, Math.max.apply(null, days.map(function (d) { return d.plays })))
    var NS = 'http://www.w3.org/2000/svg'
    var box = el('div', 'stats-chart')
    var svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H)
    svg.setAttribute('preserveAspectRatio', 'none')
    svg.setAttribute('role', 'img')
    var total = days.reduce(function (a, d) { return a + d.plays }, 0)
    svg.setAttribute('aria-label', 'Plays per day for the last 30 days: ' + total + ' in all')
    var base = document.createElementNS(NS, 'line')
    base.setAttribute('x1', 0)
    base.setAttribute('x2', W)
    base.setAttribute('y1', H - 0.5)
    base.setAttribute('y2', H - 0.5)
    base.setAttribute('class', 'stats-chart-base')
    svg.appendChild(base)
    var tip = el('div', 'stats-chart-tip')
    tip.hidden = true
    days.forEach(function (d, i) {
      var x = i * (bw + gap)
      var h = d.plays ? Math.max(3, (d.plays / max) * (H - 4)) : 0
      // A hit area as tall as the chart, so thin and empty days can still be hovered.
      var hit = document.createElementNS(NS, 'rect')
      hit.setAttribute('x', x)
      hit.setAttribute('y', 0)
      hit.setAttribute('width', bw + gap)
      hit.setAttribute('height', H)
      hit.setAttribute('class', 'stats-chart-hit')
      if (h) {
        var bar = document.createElementNS(NS, 'path')
        var r = Math.min(2, bw / 2, h)
        var y = H - h
        bar.setAttribute('d', 'M' + x + ',' + H + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + y + ' ' + (x + bw) + ',' + (y + r) + 'V' + H + 'Z')
        bar.setAttribute('class', 'stats-chart-bar')
        svg.appendChild(bar)
      }
      var show = function () {
        tip.textContent = day(d.day) + ': ' + n(d.plays) + (d.plays === 1 ? ' play' : ' plays')
        tip.style.left = ((x + bw / 2) / W) * 100 + '%'
        tip.hidden = false
      }
      hit.addEventListener('mouseenter', show)
      hit.addEventListener('click', show)
      svg.appendChild(hit)
    })
    svg.addEventListener('mouseleave', function () {
      tip.hidden = true
    })
    box.appendChild(svg)
    box.appendChild(tip)
    var axis = el('div', 'stats-chart-axis')
    axis.appendChild(el('span', '', day(days[0].day)))
    axis.appendChild(el('span', '', 'Today'))
    box.appendChild(axis)
    return box
  }

  function gameCard(g) {
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
    names.appendChild(el('div', 'stats-game-where' + (g.hidden ? ' bad' : ''), where + (g.category && g.category !== 'Other' ? ' · ' + g.category : '') + (g.phone ? ' · Phones' : '')))
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
    add('Plays', n(g.plays), 'Every time someone opened it, once a day per device')
    add('Last 7 days', n(g.plays_7d))
    add('Last 24 hours', n(g.plays_24h))
    add('Players', n(g.players), 'Different people who played it on mirg.ai')
    add('Came back', n(g.returning_players), 'Players who played it again on another day')
    add('Avg. play time', playTime(g.avg_seconds), 'On computers. Phones open the game on its own page, so their time is not known')
    add('From suggestions', n(g.from_suggestions), 'Players who found it in For you or Play next')
    add('Comments', n(g.comments))
    if (g.leaderboard_players) add('On the leaderboard', n(g.leaderboard_players))
    card.appendChild(nums)
    if (g.by_day && g.by_day.length) {
      card.appendChild(el('div', 'stats-chart-title', 'Plays, last 30 days'))
      card.appendChild(chart(g.by_day.map(function (d) { return { day: String(d.day).slice(0, 10), plays: Number(d.plays) || 0 } })))
    }
    return card
  }

  function show(data) {
    var t = data.totals || {}
    var tiles = $('stats-tiles')
    tiles.textContent = ''
    tiles.appendChild(tile('Plays', n(t.plays)))
    tiles.appendChild(tile('Plays, last 7 days', n(t.plays_7d)))
    tiles.appendChild(tile('Plays, last 24 hours', n(t.plays_24h)))
    tiles.appendChild(tile('Players', n(t.players), 'Different people who played your games on mirg.ai'))
    tiles.appendChild(tile('Comments', n(t.comments)))
    tiles.hidden = false
    var games = data.games || []
    $('stats-sub').textContent = games.length === 1 ? 'Your 1 shared game.' : 'Your ' + games.length + ' shared games, most played first.'
    $('stats-note').textContent = 'Players, play time and suggestions are counted from November 13, 2026' + (data.days_since ? '; plays per day from ' + new Date(data.days_since + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : '') + '. Total plays go back to when each game was shared.'
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
    return fetch(SUPABASE + '/functions/v1/api/stats', { headers: { authorization: 'Bearer ' + t } })
      .then(function (r) {
        return r.json().then(function (body) {
          if (r.status === 401) {
            $('stats-signin').hidden = false
            return
          }
          if (!r.ok) throw new Error((body.error && body.error.message) || 'The stats could not load.')
          show(body)
        })
      })
      .catch(function (e) {
        $('stats-error').textContent = (e && e.message) || 'The stats could not load. Refresh the page to try again.'
        $('stats-error').hidden = false
      })
  })
})()
