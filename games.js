// The games page (every shared game whose maker chose to show it, to search and sort, with the
// most played one on top) and a creator's page at /u/<name> (that creator's shown games, most
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
      pic.textContent = game.title
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
  function card(game, showBy) {
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
    var plays = document.createElement('span')
    plays.className = 'game-plays'
    plays.textContent = plural(Number(game.plays) || 0, 'play', 'plays')
    name.appendChild(title)
    name.appendChild(plays)
    a.appendChild(picture(game))
    a.appendChild(name)
    box.appendChild(a)
    if (showBy && game.handle) box.appendChild(byline(game))
    return box
  }
  /** The most played game, shown large at the top of the games page. */
  function spotlightOf(game) {
    var box = document.createElement('div')
    box.className = 'game-spotlight'
    var pic = document.createElement('a')
    pic.className = 'game-spotlight-pic'
    pic.href = playPath(game)
    pic.setAttribute('aria-label', 'Play ' + game.title)
    pic.appendChild(picture(game))
    var info = document.createElement('div')
    info.className = 'game-spotlight-info'
    var label = document.createElement('span')
    label.className = 'game-spotlight-label'
    label.textContent = 'Most played'
    var title = document.createElement('h2')
    title.textContent = game.title
    var plays = document.createElement('span')
    plays.className = 'game-plays'
    plays.textContent = plural(Number(game.plays) || 0, 'play', 'plays')
    var play = document.createElement('a')
    play.className = 'btn primary'
    play.href = playPath(game)
    play.textContent = 'Play now'
    info.appendChild(label)
    info.appendChild(title)
    if (game.handle) info.appendChild(byline(game))
    info.appendChild(plays)
    info.appendChild(play)
    box.appendChild(pic)
    box.appendChild(info)
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

  placeholders()

  if (!creatorHead) {
    var search = document.getElementById('games-search')
    var count = document.getElementById('games-count')
    var none = document.getElementById('games-none')
    var noneText = document.getElementById('games-none-text')
    var spotlight = document.getElementById('games-spotlight')
    var sorts = [].slice.call(document.querySelectorAll('[data-sort]'))
    var params = new URLSearchParams(location.search)
    var sort = params.get('sort') === 'plays' ? 'plays' : 'new'
    var games = []
    var top = null
    search.value = params.get('q') || ''

    // The search and sort stay in the address, so a filtered list can be shared or reloaded.
    function remember() {
      var next = new URLSearchParams()
      if (search.value.trim()) next.set('q', search.value.trim())
      if (sort === 'plays') next.set('sort', 'plays')
      var query = next.toString()
      try {
        history.replaceState(null, '', location.pathname + (query ? '?' + query : ''))
      } catch (e) {}
    }
    function render() {
      var words = plain(search.value).split(/\s+/).filter(Boolean)
      var found = games.filter(function (g) {
        var text = plain(g.title + ' ' + (g.handle || ''))
        return words.every(function (w) {
          return text.indexOf(w) !== -1
        })
      })
      found.sort(function (a, b) {
        return sort === 'plays' ? b.plays - a.plays : b.updated_at.localeCompare(a.updated_at)
      })
      var featured = words.length ? null : top
      spotlight.hidden = !featured
      grid.textContent = ''
      found.forEach(function (g) {
        if (g === featured) return
        g.card = g.card || card(g, true)
        grid.appendChild(g.card)
      })
      count.textContent = words.length ? found.length + ' of ' + plural(games.length, 'game', 'games') : plural(games.length, 'game', 'games')
      none.hidden = found.length > 0
      noneText.textContent = 'No games match "' + search.value.trim() + '".'
      sorts.forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.sort === sort))
      })
    }
    search.addEventListener('input', function () {
      render()
      remember()
    })
    sorts.forEach(function (b) {
      b.addEventListener('click', function () {
        sort = b.dataset.sort
        render()
        remember()
      })
    })
    document.getElementById('games-clear').addEventListener('click', function () {
      search.value = ''
      render()
      remember()
      search.focus()
    })

    get('public_games?select=slug,title,updated_at,plays,handle&limit=1000')
      .then(function (list) {
        games = list
        games.forEach(function (g) {
          g.plays = Number(g.plays) || 0
          if (g.plays && (!top || g.plays > top.plays)) top = g
        })
        if (!games.length) {
          grid.textContent = ''
          empty.hidden = false
          return
        }
        document.getElementById('games-tools').hidden = false
        if (top) spotlight.appendChild(spotlightOf(top))
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
  Promise.all([get('public_creators?select=handle,link&handle=eq.' + handle), get('public_games?select=slug,title,updated_at,plays,handle&handle=eq.' + handle + '&order=plays.desc&limit=120')])
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
