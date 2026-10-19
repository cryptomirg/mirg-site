// The play page: shows a game someone shared from Mirg, by the name in ?g=<name>.
// The game itself is served from a separate domain, so it never runs on mirg.ai.
;(function () {
  var PLAY_HOST = 'PLAY_HOST_PLACEHOLDER'
  var name = new URLSearchParams(location.search).get('g') || ''
  var frame = document.getElementById('play-game')
  var title = document.getElementById('play-title')
  var missing = document.getElementById('play-missing')
  function gone() {
    title.textContent = 'Game not found'
    frame.hidden = true
    missing.hidden = false
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
    })
    .catch(gone)
  document.getElementById('play-full').addEventListener('click', function () {
    var el = document.getElementById('play-frame')
    if (el.requestFullscreen) el.requestFullscreen()
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
  })
})()
