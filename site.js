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

// The demonstration on the home page: a short film of the app at work, acted out with the real
// interface pieces and the real game. A prompt is typed, the agent's steps appear one by one,
// the game comes up, and the agent plays it by pressing its keys.
;(function () {
  var wrap = document.getElementById('demo')
  if (!wrap) return
  var stage = wrap.querySelector('.demo-stage')
  var scroll = document.getElementById('m-scroll')
  var input = document.getElementById('m-input')
  var send = document.getElementById('m-send')
  var frame = document.getElementById('m-frame')
  var empty = document.getElementById('m-empty')
  var cover = document.getElementById('m-cover')
  var log = document.getElementById('m-log')
  var run = document.getElementById('m-run')
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var take = 0

  // Keep the window's real proportions at any page width.
  function fit() {
    stage.style.setProperty('--demo-scale', String(Math.min(1, wrap.clientWidth / 1040)))
  }
  fit()
  window.addEventListener('resize', fit)

  function el(cls, html) {
    var node = document.createElement('div')
    node.className = cls
    node.innerHTML = html
    scroll.appendChild(node)
    return node
  }
  function wait(ms, mine) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        mine === take ? resolve() : reject(new Error('replaced'))
      }, still ? Math.min(ms, 60) : ms)
    })
  }
  // Press or release one of the game's keys, the way the agent's playtest does.
  function key(type, code) {
    try {
      frame.contentWindow.dispatchEvent(new KeyboardEvent(type, { code: code, bubbles: true }))
    } catch (e) {}
  }
  function tap(code, ms, mine) {
    key('keydown', code)
    return wait(ms, mine).then(function () {
      key('keyup', code)
    })
  }
  // The agent's playtests, acted out by watching where the fox is rather than by the clock,
  // so they come out the same on a slow phone and a fast laptop.
  function fox() {
    try {
      return { p: frame.contentWindow.__player, g: frame.contentWindow.__game }
    } catch (e) {
      return {}
    }
  }
  function until(test, mine, limit) {
    var started = Date.now()
    return new Promise(function (resolve, reject) {
      ;(function poll() {
        if (mine !== take) return reject(new Error('replaced'))
        var s = fox()
        if ((s.p && test(s.p, s.g)) || Date.now() - started > (limit || 6000)) return resolve()
        setTimeout(poll, 25)
      })()
    })
  }
  function jump(mine) {
    return tap('Space', 220, mine)
  }
  // Start the level, run along the ground through the first coins, with one hop on the way.
  function firstPlaytest(mine) {
    return until(function (p, g) { return g && g.state === 'title' }, mine, 4000)
      .then(function () {
        key('keydown', 'Enter')
        key('keyup', 'Enter')
        return until(function (p, g) { return g.state === 'play' }, mine, 2000)
      })
      .then(function () { return wait(350, mine) })
      .then(function () {
        key('keydown', 'ArrowRight')
        return until(function (p) { return p.x >= 190 }, mine)
      })
      .then(function () { return jump(mine) })
      .then(function () { return until(function (p) { return p.x >= 530 }, mine) })
      .then(function () {
        key('keyup', 'ArrowRight')
        return wait(500, mine)
      })
  }
  // The new double jump: up to the high ledge that one jump cannot reach.
  function secondPlaytest(mine) {
    key('keydown', 'ArrowRight')
    // Take off once clear of the low platform overhead, holding jump for its full height.
    return until(function (p) { return p.x >= 690 }, mine)
      .then(function () {
        key('keydown', 'Space')
        // Second jump near the top of the first.
        return until(function (p) { return !p.onGround && p.vy > -200 }, mine, 1500)
      })
      .then(function () {
        key('keyup', 'Space')
        return wait(30, mine)
      })
      .then(function () {
        key('keydown', 'Space')
        // Give the game a moment to act on the press before watching for the top of the jump.
        return wait(120, mine)
      })
      .then(function () {
        return until(function (p) { return p.vy > 0 }, mine, 1500)
      })
      .then(function () {
        key('keyup', 'Space')
        return until(function (p) { return p.x >= 900 }, mine, 2500)
      })
      .then(function () {
        key('keyup', 'ArrowRight')
        return until(function (p) { return p.onGround }, mine, 2500)
      })
      .then(function () { return wait(400, mine) })
  }

  function type(text, mine) {
    input.innerHTML = '<span class="m-caret"></span>'
    var caret = input.firstChild
    var i = 0
    function next() {
      if (i >= text.length) return Promise.resolve()
      caret.textContent = text.slice(0, ++i)
      return wait(text[i - 1] === ' ' ? 34 : 22, mine).then(next)
    }
    return next().then(function () {
      send.classList.add('ready')
      return wait(380, mine)
    })
  }
  function submit(text, mine) {
    send.classList.add('press')
    return wait(140, mine).then(function () {
      send.classList.remove('press', 'ready')
      input.innerHTML = '<span class="m-placeholder">Ask for a change…</span>'
      el('m-user', text)
    })
  }
  function think(ms, mine) {
    var node = el('m-think', '<i></i>Thinking…')
    return wait(ms, mine).then(function () {
      node.remove()
    })
  }
  // A step the agent takes: shown working, then ticked with how long it took.
  function tool(title, ms, mine, during) {
    var node = el('m-tool', '<i></i><span>' + title + '</span>')
    var started = Date.now()
    return Promise.all([wait(ms, mine), during ? during() : null]).then(function () {
      var took = still ? ms : Date.now() - started
      node.classList.add('done')
      if (took >= 900) node.insertAdjacentHTML('beforeend', '<small>' + (took / 1000).toFixed(1) + 's</small>')
    })
  }

  function play() {
    var mine = ++take
    var PROMPT = 'A side-scrolling platformer where a fox collects coins and avoids spikes. Three short levels.'
    scroll.innerHTML = ''
    input.innerHTML = '<span class="m-placeholder">Describe what you want…</span>'
    send.classList.remove('ready', 'press')
    frame.classList.remove('on')
    frame.removeAttribute('src')
    empty.hidden = false
    cover.hidden = true
    run.textContent = '▶ Run'
    log.textContent = 'Game output and errors appear here.'

    wait(700, mine)
      .then(function () {
        return type(PROMPT, mine)
      })
      .then(function () {
        return submit(PROMPT, mine)
      })
      .then(function () {
        empty.hidden = true
        cover.hidden = false
        return think(1300, mine)
      })
      .then(function () {
        return tool('Write index.html', 500, mine)
      })
      .then(function () {
        return tool('Write levels.js', 650, mine)
      })
      .then(function () {
        return tool('Write main.js', 1500, mine)
      })
      .then(function () {
        // The game really loads here, behind the cover, as it does in the app.
        frame.setAttribute('src', frame.getAttribute('data-src'))
        return tool('Run the game', 1300, mine)
      })
      .then(function () {
        log.innerHTML = 'system&nbsp;&nbsp;&nbsp;Game running at http://127.0.0.1:52842/'
        run.textContent = '↻ Restart'
        // In the app the game stays covered until the agent is done, with a "Watch anyway"
        // link. Here it is uncovered so that the agent can be seen playing.
        cover.hidden = true
        frame.classList.add('on')
        return tool('Look at the game', 900, mine)
      })
      .then(function () {
        return tool('Playtest (7 inputs)', 1200, mine, function () {
          return firstPlaytest(mine)
        })
      })
      .then(function () {
        el('m-agent', 'Your platformer is running in the Game tab. I played the start of level 1 to check it: the fox runs, jumps and collects coins. <strong>Arrow keys</strong> to move, <strong>Space</strong> to jump.')
        return wait(2400, mine)
      })
      .then(function () {
        return type('Add a double jump', mine)
      })
      .then(function () {
        return submit('Add a double jump', mine)
      })
      .then(function () {
        return think(900, mine)
      })
      .then(function () {
        return tool('Edit main.js', 900, mine)
      })
      .then(function () {
        return tool('Playtest (6 inputs)', 1200, mine, function () {
          return secondPlaytest(mine)
        })
      })
      .then(function () {
        el('m-agent', 'Done. Press jump again in mid-air for a second jump. I tested it: the fox reached a ledge it could not get to before.')
      })
      .catch(function () {})
  }

  document.getElementById('demo-replay').addEventListener('click', play)
  // Start when the demo scrolls into view, so nobody misses the beginning.
  if ('IntersectionObserver' in window) {
    var seen = new IntersectionObserver(
      function (entries) {
        if (entries[0].isIntersecting) {
          seen.disconnect()
          play()
        }
      },
      { threshold: 0.3 }
    )
    seen.observe(wrap)
  } else {
    play()
  }
})()
