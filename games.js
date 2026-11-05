// The games page (every shared game whose maker chose to show it, to search, filter and sort, with
// the three most played of the last 24 hours on top) and a creator's page at /u/<name> (that creator's shown games, most
// played first). The lists come from Mirg's database as public, read-only lists; each game plays
// on its own page.
;(function () {
  var REST = 'https://dlnmbeqdtpyjkprkxfvt.supabase.co/rest/v1/'
  var KEY = 'sb_publishable_RTQ8CSTfuHByAw1-_bbqag_NX0-kQhp'
  var PLAY_HOST = 'https://play.mirg.ai'
  var grid = document.getElementById('games-grid')
  var empty = document.getElementById('games-empty')
  var creatorHead = document.getElementById('creator-name')
  function get(path) {
    return fetch(REST + path, { headers: { apikey: KEY, authorization: 'Bearer ' + KEY } }).then(function (r) {
      if (!r.ok) throw new Error('list failed')
      return r.json()
    })
  }
  function plural(n, one, many) {
    return n === 1 ? '1 ' + one : n.toLocaleString() + ' ' + many
  }
  function playPath(game) {
    return '/play?g=' + encodeURIComponent(game.slug)
  }
  function picture(game) {
    var pic = document.createElement('div')
    pic.className = 'game-thumb'
    var img = document.createElement('img')
    img.alt = ''
    img.loading = 'lazy'
    img.src = PLAY_HOST + '/' + game.slug + '/mirg-thumb.jpg'
    // Games shared while they were not running have no picture: show the title instead.
    img.onerror = function () {
      img.remove()
      pic.classList.add('none')
      pic.insertBefore(document.createTextNode(game.title), pic.firstChild)
    }
    pic.appendChild(img)
    return pic
  }
  function byline(game) {
    var by = document.createElement('a')
    by.className = 'game-by'
    by.href = '/u/' + game.handle
    by.textContent = 'by @' + game.handle
    return by
  }
  function badge(className, text) {
    var tag = document.createElement('span')
    tag.className = className
    tag.textContent = text
    return tag
  }
  function card(game, showBy, rank) {
    var box = document.createElement('div')
    box.className = 'game-card'
    var a = document.createElement('a')
    a.className = 'game-open'
    a.href = playPath(game)
    var name = document.createElement('div')
    name.className = 'game-name'
    var title = document.createElement('span')
    title.className = 'game-title'
    title.textContent = game.title
    // A play icon and the count: "▶ 120", or "▶ 12 today" in the top three.
    var plays = document.createElement('span')
    plays.className = 'game-plays'
    var today = rank && game.plays_today
    var n = today ? game.plays_today : Number(game.plays) || 0
    plays.setAttribute('aria-label', plural(n, 'play', 'plays') + (today ? ' today' : ''))
    plays.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 1.8v8.4a.6.6 0 0 0 .9.5l6.6-4.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5Z" fill="currentColor"/></svg>'
    plays.appendChild(document.createTextNode(n.toLocaleString() + (today ? ' today' : '')))
    name.appendChild(title)
    name.appendChild(plays)
    var pic = picture(game)
    if (rank) pic.appendChild(badge('game-rank', '#' + rank))
    if (game.category && game.category !== 'Other') pic.appendChild(badge('game-type', game.category))
    a.appendChild(pic)
    a.appendChild(name)
    box.appendChild(a)
    if (showBy && game.handle) box.appendChild(byline(game))
    return box
  }
  function show(games, showBy) {
    grid.textContent = ''
    if (!games.length) return (empty.hidden = false)
    games.forEach(function (g) {
      grid.appendChild(card(g, showBy))
    })
  }
  function placeholders() {
    for (var i = 0; i < 8; i++) {
      var box = document.createElement('div')
      box.className = 'game-card loading'
      grid.appendChild(box)
    }
  }
  /** Lower case with accents and punctuation gone, so "dont" finds "Don't Fall Off". */
  function plain(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .toLowerCase()
  }

  var FIELDS = 'slug,title,created_at,updated_at,plays,plays_today,handle,category'
  function date(text) {
    return Date.parse(text) || 0
  }
  var SORTS = {
    new: function (a, b) {
      return date(b.created_at) - date(a.created_at)
    },
    updated: function (a, b) {
      return date(b.updated_at) - date(a.updated_at)
    },
    old: function (a, b) {
      return date(a.created_at) - date(b.created_at)
    },
    plays: function (a, b) {
      return b.plays - a.plays
    },
    today: function (a, b) {
      return b.plays_today - a.plays_today || b.plays - a.plays
    },
    az: function (a, b) {
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    },
    za: function (a, b) {
      return b.title.localeCompare(a.title, undefined, { sensitivity: 'base' })
    }
  }

  placeholders()

  if (!creatorHead) {
    var search = document.getElementById('games-search')
    var count = document.getElementById('games-count')
    var none = document.getElementById('games-none')
    var noneText = document.getElementById('games-none-text')
    var topBox = document.getElementById('games-top')
    var topList = document.getElementById('games-top-list')
    var sortBox = document.getElementById('games-sort')
    var typeBox = document.getElementById('games-types')
    var params = new URLSearchParams(location.search)
    var games = []
    var type = params.get('type') || ''
    if (SORTS[params.get('sort')]) sortBox.value = params.get('sort')
    search.value = params.get('q') || ''

    // The search and sort stay in the address, so a filtered list can be shared or reloaded.
    function remember() {
      var next = new URLSearchParams()
      if (search.value.trim()) next.set('q', search.value.trim())
      if (sortBox.value !== 'new') next.set('sort', sortBox.value)
      if (type) next.set('type', type)
      var query = next.toString()
      try {
        history.replaceState(null, '', location.pathname + (query ? '?' + query : ''))
      } catch (e) {}
    }
    function render() {
      var words = plain(search.value).split(/\s+/).filter(Boolean)
      var found = games.filter(function (g) {
        var text = plain(g.title + ' ' + (g.handle || ''))
        return (
          (!type || g.category === type) &&
          words.every(function (w) {
            return text.indexOf(w) !== -1
          })
        )
      })
      found.sort(SORTS[sortBox.value])
      var filtered = words.length > 0 || Boolean(type)
      topBox.hidden = filtered || !topList.children.length
      grid.textContent = ''
      found.forEach(function (g) {
        g.card = g.card || card(g, true)
        grid.appendChild(g.card)
      })
      count.textContent = filtered ? found.length + ' of ' + plural(games.length, 'game', 'games') : plural(games.length, 'game', 'games')
      none.hidden = found.length > 0
      noneText.textContent = 'No ' + (type ? type + ' ' : '') + 'games' + (words.length ? ' match "' + search.value.trim() + '".' : ' yet.')
      ;[].forEach.call(typeBox.children, function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.type === type))
      })
    }
    function changed() {
      render()
      remember()
    }
    search.addEventListener('input', changed)
    sortBox.addEventListener('change', changed)
    document.getElementById('games-clear').addEventListener('click', function () {
      search.value = ''
      type = ''
      changed()
      search.focus()
    })

    get('public_games?select=' + FIELDS + '&limit=1000')
      .then(function (list) {
        games = list
        games.forEach(function (g) {
          g.plays = Number(g.plays) || 0
          g.plays_today = Number(g.plays_today) || 0
        })
        if (!games.length) {
          grid.textContent = ''
          empty.hidden = false
          return
        }
        document.getElementById('games-tools').hidden = false
        // Only the types that have games, plus a way back to all of them.
        var types = games
          .map(function (g) {
            return g.category
          })
          .filter(function (c, i, all) {
            return c && c !== 'Other' && all.indexOf(c) === i
          })
          .sort()
        if (types.length) {
          ;[''].concat(types).forEach(function (t) {
            var chip = document.createElement('button')
            chip.type = 'button'
            chip.textContent = t || 'All'
            chip.dataset.type = t
            chip.addEventListener('click', function () {
              type = t
              changed()
            })
            typeBox.appendChild(chip)
          })
          typeBox.hidden = false
        }
        // Early on, or on a quiet day, the most played of all time fill any empty places.
        var top = games.filter(function (g) {
          return g.plays > 0
        })
        top.sort(SORTS.today)
        top.slice(0, 3).forEach(function (g, i) {
          topList.appendChild(card(g, true, i + 1))
        })
        document.getElementById('games-top-title').textContent = top.length && top[0].plays_today ? 'Top games today' : 'Most played'
        render()
      })
      .catch(function () {
        grid.textContent = ''
        empty.textContent = 'The games could not load. Refresh the page to try again.'
        empty.hidden = false
      })
    return
  }

  // A creator's page.
  var handle = (new URLSearchParams(location.search).get('u') || '').toLowerCase()
  var sub = document.getElementById('creator-sub')
  var link = document.getElementById('creator-link')
  function missing() {
    creatorHead.textContent = 'Creator not found'
    sub.textContent = 'There is no creator by that name, or they have no games on mirg.ai/games yet.'
    document.getElementById('creator-grid-wrap').hidden = true
  }
  if (!/^[a-z0-9_]{3,20}$/.test(handle)) return missing()
  // Show the short address, mirg.ai/u/<name>, in the address bar.
  try {
    history.replaceState(null, '', '/u/' + handle)
  } catch (e) {}
  Promise.all([get('public_creators?select=handle,link&handle=eq.' + handle), get('public_games?select=' + FIELDS + '&handle=eq.' + handle + '&order=plays.desc&limit=120')])
    .then(function (both) {
      var creator = both[0][0]
      var games = both[1]
      if (!creator) return missing()
      creatorHead.textContent = '@' + creator.handle
      document.title = '@' + creator.handle + ' · Games made with Mirg'
      var total = games.reduce(function (n, g) {
        return n + (Number(g.plays) || 0)
      }, 0)
      sub.textContent = plural(games.length, 'game', 'games') + ' · ' + plural(total, 'play', 'plays')
      if (creator.link) {
        link.href = creator.link
        link.textContent = creator.link.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '') + ' ↗'
        link.hidden = false
      }
      show(games, false)
    })
    .catch(missing)
})()
