// The games page: every shared game whose maker chose to show it here, newest first.
// The list comes from Mirg's database (a public, read-only list); each game plays on its own page.
;(function () {
  var API = 'https://dlnmbeqdtpyjkprkxfvt.supabase.co/rest/v1/public_games?select=slug,title,updated_at&limit=120'
  var KEY = 'sb_publishable_RTQ8CSTfuHByAw1-_bbqag_NX0-kQhp'
  var PLAY_HOST = 'https://mirg-play.miladmirghahari.workers.dev'
  var grid = document.getElementById('games-grid')
  var empty = document.getElementById('games-empty')
  function card(game) {
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
    name.textContent = game.title
    a.appendChild(pic)
    a.appendChild(name)
    return a
  }
  fetch(API, { headers: { apikey: KEY, authorization: 'Bearer ' + KEY } })
    .then(function (r) {
      return r.ok ? r.json() : []
    })
    .then(function (games) {
      if (!games.length) return (empty.hidden = false)
      games.forEach(function (g) {
        grid.appendChild(card(g))
      })
    })
    .catch(function () {
      empty.hidden = false
    })
})()
