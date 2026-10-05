// Points the download buttons at the newest release. The installers are published on GitHub
// under names that include the version, so the newest one is looked up when the page opens.
// If that fails (offline, or GitHub is unreachable), the buttons lead to the releases page.
;(function () {
  var REPO = 'cryptomirg/mirg-releases'
  var fallback = 'https://github.com/' + REPO + '/releases/latest'
  var links = document.querySelectorAll('[data-download]')
  if (!links.length) return
  links.forEach(function (a) {
    a.href = fallback
  })
  fetch('https://api.github.com/repos/' + REPO + '/releases/latest')
    .then(function (r) {
      return r.ok ? r.json() : null
    })
    .then(function (release) {
      if (!release) return
      var find = function (test) {
        var asset = (release.assets || []).find(function (a) {
          return test(a.name)
        })
        return asset ? asset.browser_download_url : null
      }
      var urls = {
        'mac-arm64': find(function (n) {
          return /-arm64\.dmg$/.test(n)
        }),
        'mac-x64': find(function (n) {
          return /\.dmg$/.test(n) && !/arm64/.test(n)
        })
      }
      links.forEach(function (a) {
        var url = urls[a.getAttribute('data-download')]
        if (url) a.href = url
      })
      var version = (release.tag_name || '').replace(/^v/, '')
      document.querySelectorAll('[data-version]').forEach(function (el) {
        if (version) el.textContent = 'Version ' + version
      })
    })
    .catch(function () {})
})()

// The live demo on the home page: replays the steps of a real session in the chat, then
// uncovers the finished game, which is the real thing and can be played.
;(function () {
  var demo = document.getElementById('demo')
  if (!demo) return
  var frame = document.getElementById('demo-frame')
  var cover = document.getElementById('demo-cover')
  var play = document.getElementById('demo-play')
  var building = cover.querySelector('.demo-building')
  var steps = Array.prototype.slice.call(demo.querySelectorAll('[data-step]'))
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var timers = []

  function finish() {
    building.hidden = true
    play.hidden = false
    cover.classList.add('ready')
  }

  function replay() {
    timers.forEach(clearTimeout)
    timers = []
    // The game loads behind the cover while the steps play.
    if (!frame.getAttribute('src')) frame.setAttribute('src', frame.getAttribute('data-src'))
    cover.classList.remove('gone', 'ready')
    building.hidden = false
    play.hidden = true
    frame.setAttribute('tabindex', '-1')
    if (still) {
      demo.classList.remove('animating')
      return finish()
    }
    demo.classList.add('animating')
    steps.forEach(function (el) {
      el.classList.remove('shown')
    })
    var at = 300
    steps.forEach(function (el, i) {
      // A person's message lingers a little; the agent's steps tick by.
      at += el.classList.contains('d-user') ? (i ? 1300 : 0) : el.classList.contains('d-agent') ? 900 : 520
      timers.push(
        setTimeout(function () {
          el.classList.add('shown')
          if (el.hasAttribute('data-done')) finish()
        }, at)
      )
    })
  }

  play.addEventListener('click', function () {
    cover.classList.add('gone')
    frame.removeAttribute('tabindex')
    frame.focus()
    try {
      frame.contentWindow.focus()
    } catch (e) {}
  })
  document.getElementById('demo-replay').addEventListener('click', replay)

  // Start when the demo scrolls into view, so nobody misses it.
  if ('IntersectionObserver' in window) {
    var seen = new IntersectionObserver(
      function (entries) {
        if (entries[0].isIntersecting) {
          seen.disconnect()
          replay()
        }
      },
      { threshold: 0.35 }
    )
    seen.observe(demo)
  } else {
    replay()
  }
})()
