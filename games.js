// The games page (every shared game whose maker chose to show it, newest first) and a creator's
// page at /u/<name> (that creator's shown games, most played first). The lists come from Mirg's
// database as public, read-only lists; each game plays on its own page.
;(function () {
  var REST = 'https://dlnmbeqdtpyjkprkxfvt.supabase.co/rest/v1/'
  var KEY = 'sb_publishable_RTQ8CSTfuHByAw1-_bbqag_NX0-kQhp'
  var PLAY_HOST = 'https://mirg-play.miladmirghahari.workers.dev'
  var grid = document.getElementById('games-grid')
  var empty = document.getElementById('games-empty')
  var creatorHead = document.getElementById('creator-name')
  function get(path) {
    return fetch(REST + path, { headers: { apikey: KEY, authorization: 'Bearer ' + KEY } }).then(function (r) {
      return r.ok ? r.json() : []
    })
  }
  function plural(n, one, many) {
    return n === 1 ? '1 ' + one : n.toLocaleString() + ' ' + many
  }
  function card(game, showBy) {
    var a = document.createElement('a')
    a.className = 'game-card'
    a.href = '/play?g=' + encodeURIComponent(game.slug)
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
    a.appendChild(pic)
    a.appendChild(name)
    if (showBy && game.handle) {
      var by = document.createElement('div')
      by.className = 'game-by'
      by.textContent = 'by @' + game.handle
      a.appendChild(by)
    }
    return a
  }
  function show(games, showBy) {
    if (!games.length) return (empty.hidden = false)
    games.forEach(function (g) {
      grid.appendChild(card(g, showBy))
    })
  }
  function failed() {
    empty.hidden = false
  }

  if (!creatorHead) {
    get('public_games?select=slug,title,updated_at,plays,handle&limit=120')
      .then(function (games) {
        show(games, true)
      })
      .catch(failed)
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
