// The play page: shows a game someone shared from Mirg, by the name in ?g=<name>.
// The game itself is served from a separate domain, so it never runs on mirg.ai.
;(function () {
  var PLAY_HOST = 'https://mirg-play.miladmirghahari.workers.dev'
  var name = new URLSearchParams(location.search).get('g') || ''
  var frame = document.getElementById('play-game')
  var title = document.getElementById('play-title')
  var missing = document.getElementById('play-missing')
  function gone() {
    title.textContent = 'Game not found'
    frame.hidden = true
    missing.hidden = false
  }
  // One play per visitor per game per day, so reloading the page does not add to the count.
  function countPlay() {
    var key = 'mirg-played-' + name
    var today = new Date().toISOString().slice(0, 10)
    try {
      if (localStorage.getItem(key) === today) return
      localStorage.setItem(key, today)
    } catch (e) {}
    var KEY = 'sb_publishable_RTQ8CSTfuHByAw1-_bbqag_NX0-kQhp'
    fetch('https://dlnmbeqdtpyjkprkxfvt.supabase.co/rest/v1/rpc/count_play', {
      method: 'POST',
      headers: { apikey: KEY, authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ game: name })
    }).catch(function () {})
  }
  if (!/^[a-z0-9-]{3,64}$/.test(name)) return gone()
  var base = PLAY_HOST + '/' + name + '/'
  fetch(base + 'mirg-share.json')
    .then(function (r) {
      if (!r.ok) throw new Error('missing')
      return r.json()
    })
    .then(function (info) {
      var t = String(info.title || 'A game made with Mirg').slice(0, 80)
      title.textContent = t
      document.title = t + ' · Made with Mirg'
      frame.src = base
      countPlay()
    })
    .catch(gone)
  // iPhones have no full screen for a page element, so there the game fills the window instead.
  var box = document.getElementById('play-frame')
  var exit = document.getElementById('play-exit')
  function fill(on) {
    box.classList.toggle('filled', on)
    document.documentElement.classList.toggle('play-filled', on)
    exit.hidden = !on
  }
  document.getElementById('play-full').addEventListener('click', function () {
    if (box.requestFullscreen) box.requestFullscreen().catch(function () { fill(true) })
    else if (box.webkitRequestFullscreen) box.webkitRequestFullscreen()
    else fill(true)
  })
  exit.addEventListener('click', function () { fill(false) })
})()
