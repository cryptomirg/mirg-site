// Keep addresses clean: someone who arrives at /index.html or /pricing.html sees / or /pricing.
;(function () {
  var path = location.pathname
  var clean = path.replace(/\/index\.html$/, '/').replace(/\.html$/, '')
  if (clean !== path && window.history && history.replaceState) history.replaceState(null, '', clean + location.search + location.hash)
})()

// Download buttons. The installers are published on GitHub under names that include the
// version, so the newest one is looked up when the page opens. The main button offers the
// download for the computer the visitor is on. If the lookup fails (offline, or GitHub is
// unreachable), every button leads to the page of releases instead.
;(function () {
  var REPO = 'cryptomirg/mirg-releases'
  var fallback = 'https://github.com/' + REPO + '/releases/latest'

  // What kind of computer is this? Returns 'mac-arm64', 'mac-x64', 'windows', 'linux' or 'mobile'.
  function detect() {
    var ua = navigator.userAgent || ''
    var data = navigator.userAgentData
    var touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1 // an iPad pretending to be a Mac
    if (/Android|iPhone|iPad|iPod/.test(ua) || touchMac || (data && data.mobile)) return Promise.resolve('mobile')
    if (/Windows/.test(ua)) return Promise.resolve('windows')
    if (/Macintosh|Mac OS X/.test(ua)) {
      // Browsers on every Mac say "Intel" for compatibility, so the processor is found another way.
      if (data && data.getHighEntropyValues) {
        return data
          .getHighEntropyValues(['architecture'])
          .then(function (v) {
            return v.architecture === 'x86' ? 'mac-x64' : 'mac-arm64'
          })
          .catch(function () {
            return 'mac-arm64'
          })
      }
      try {
        var gl = document.createElement('canvas').getContext('webgl')
        var info = gl && gl.getExtension('WEBGL_debug_renderer_info')
        var renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
        if (/Intel|AMD|Radeon|NVIDIA/i.test(renderer)) return Promise.resolve('mac-x64')
      } catch (e) {}
      // Apple Silicon is the safe guess: it is most Macs in use, and its installer says so if wrong.
      return Promise.resolve('mac-arm64')
    }
    if (/Linux|X11|CrOS/.test(ua)) return Promise.resolve('linux')
    return Promise.resolve('mac-arm64')
  }

  var NAMES = { 'mac-arm64': 'Download for Mac', 'mac-x64': 'Download for Mac (Intel)' }
  var NOTES = {
    'mac-arm64': 'Free to try. For Macs with Apple Silicon, macOS 12 or later.',
    'mac-x64': 'Free to try. For Intel Macs, macOS 12 or later.',
    windows: 'Mirg is on Mac today. The Windows version is in the works.',
    linux: 'Mirg is on Mac today. The Linux version is in the works.',
    mobile: 'Mirg is an app for your computer. Open mirg.ai on a Mac to download it.'
  }

  var releaseUrls = fetch('https://api.github.com/repos/' + REPO + '/releases/latest')
    .then(function (r) {
      return r.ok ? r.json() : null
    })
    .then(function (release) {
      if (!release) return {}
      var find = function (test) {
        var asset = (release.assets || []).find(function (a) {
          return test(a.name)
        })
        return asset ? asset.browser_download_url : null
      }
      var version = (release.tag_name || '').replace(/^v/, '')
      document.querySelectorAll('[data-version]').forEach(function (el) {
        if (version) el.textContent = 'Version ' + version
      })
      return {
        'mac-arm64': find(function (n) {
          return /-arm64\.dmg$/.test(n)
        }),
        'mac-x64': find(function (n) {
          return /\.dmg$/.test(n) && !/arm64/.test(n)
        })
      }
    })
    .catch(function () {
      return {}
    })

  Promise.all([detect(), releaseUrls]).then(function (found) {
    var platform = found[0]
    var urls = found[1]
    document.querySelectorAll('[data-download]').forEach(function (a) {
      var want = a.getAttribute('data-download')
      if (want !== 'auto') {
        a.href = urls[want] || fallback
        return
      }
      if (NAMES[platform]) {
        a.textContent = NAMES[platform]
        a.href = urls[platform] || fallback
      } else {
        // Nothing to download for this device yet: lead to the list of what exists.
        a.textContent = platform === 'mobile' ? 'See downloads' : 'See all downloads'
        a.href = '/download'
      }
    })
    document.querySelectorAll('[data-platform-note]').forEach(function (el) {
      el.textContent = NOTES[platform] || NOTES['mac-arm64']
    })
    document.querySelectorAll('[data-platform="' + platform + '"]').forEach(function (el) {
      el.classList.add('current')
    })
  })
})()

// "Request a demo": a short form, sent to a small function on Mirg's server, which checks the
// "I am human" answer, limits how often one visitor can send, and saves the request.
;(function () {
  var dialog = document.getElementById('demo-form')
  if (!dialog) return
  var form = document.getElementById('demo-request')
  var status = document.getElementById('demo-form-status')
  var box = document.getElementById('demo-captcha')
  var API = 'https://dlnmbeqdtpyjkprkxfvt.supabase.co/functions/v1/demo-request'
  // Cloudflare Turnstile's public site key. While it is empty, no check is shown.
  var CAPTCHA_KEY = '0x4AAAAAAFOZ0Roo6D6Ag9sT'
  var captcha = { token: '', widget: null }

  function showCaptcha() {
    if (!CAPTCHA_KEY) return
    var render = function () {
      if (captcha.widget !== null) return window.turnstile.reset(captcha.widget)
      captcha.widget = window.turnstile.render(box, {
        sitekey: CAPTCHA_KEY,
        theme: 'dark',
        callback: function (token) {
          captcha.token = token
        },
        'expired-callback': function () {
          captcha.token = ''
        }
      })
    }
    captcha.token = ''
    if (window.turnstile) return render()
    // Loaded only when the form is opened, so the rest of the site never contacts Cloudflare.
    var script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.onload = render
    document.head.appendChild(script)
  }

  document.querySelectorAll('[data-demo-open]').forEach(function (b) {
    b.addEventListener('click', function () {
      status.textContent = ''
      status.className = 'demo-form-status'
      dialog.showModal ? dialog.showModal() : dialog.setAttribute('open', '')
      showCaptcha()
    })
  })
  document.querySelectorAll('[data-demo-close]').forEach(function (b) {
    b.addEventListener('click', function () {
      dialog.close ? dialog.close() : dialog.removeAttribute('open')
    })
  })
  dialog.addEventListener('click', function (e) {
    if (e.target === dialog) dialog.close()
  })

  form.addEventListener('submit', function (e) {
    e.preventDefault()
    var data = new FormData(form)
    var send = form.querySelector('[type="submit"]')
    var say = function (text, kind) {
      status.innerHTML = text
      status.className = 'demo-form-status' + (kind ? ' ' + kind : '')
    }
    if (CAPTCHA_KEY && !captcha.token) return say('Please wait for the "I am human" check to finish, then send again.', 'bad')
    send.disabled = true
    say('Sending…')
    fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: data.get('name'),
        email: data.get('email'),
        organisation: data.get('organisation'),
        message: data.get('message'),
        website: data.get('website'),
        captcha: captcha.token
      })
    })
      .then(function (r) {
        return r.json().then(function (body) {
          if (r.ok) {
            say('Thank you. We will be in touch by email.', 'ok')
            form.reset()
          } else {
            // The server's own explanation: a missing name, too many requests, a failed check.
            say(body.error || 'That did not send.', 'bad')
          }
          // An answer to the check can only be used once.
          showCaptcha()
        })
      })
      .catch(function () {
        say('That did not send. Please email <a href="mailto:support@mirg.ai">support@mirg.ai</a> instead.', 'bad')
      })
      .then(function () {
        send.disabled = false
      })
  })
})()

// The demonstration on the home page: a short film of the app at work, acted out with the real
// interface pieces and real games made with Mirg. A prompt is typed, the agent's steps appear
// one by one, the game comes up, and the agent plays it by pressing its keys. The buttons above
// it switch between platforms. Nothing here talks to a server or an AI model: the games are
// finished files, and the steps are a script taken from the sessions that made them.
;(function () {
  var wrap = document.getElementById('demo')
  if (!wrap) return
  var $ = function (id) {
    return document.getElementById(id)
  }
  var stage = wrap.querySelector('.demo-stage')
  var scroll = $('m-scroll')
  var input = $('m-input')
  var send = $('m-send')
  var frame = $('m-frame')
  var gameBox = frame.parentNode
  var empty = $('m-empty')
  var cover = $('m-cover')
  var win = $('m-window')
  var log = $('m-log')
  var run = $('m-run')
  var picker = $('demo-picker')
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var take = 0
  var current = null

  // Keep the window's real proportions at any page width.
  function fit() {
    stage.style.setProperty('--demo-scale', String(Math.min(1, wrap.clientWidth / 1040)))
  }
  fit()
  window.addEventListener('resize', fit)

  // ---------- the pieces a scene is made of ----------

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
      // `key` is the character or the key's name ("d", " ", "Enter"); games read one or the other.
      var name = code === 'Space' ? ' ' : /^Key/.test(code) ? code.slice(3).toLowerCase() : code
      var init = { code: code, key: name, keyCode: code === 'Enter' ? 13 : code === 'Space' ? 32 : 0, which: code === 'Enter' ? 13 : 0, bubbles: true }
      var target = frame.contentDocument.querySelector('canvas') || frame.contentWindow
      target.dispatchEvent(new KeyboardEvent(type, init))
      if (target !== frame.contentWindow) frame.contentWindow.dispatchEvent(new KeyboardEvent(type, init))
    } catch (e) {}
  }
  function tap(code, ms, mine) {
    key('keydown', code)
    return wait(ms, mine).then(function () {
      key('keyup', code)
    })
  }
  function type(text, mine) {
    input.innerHTML = '<span class="m-caret"></span>'
    var caret = input.firstChild
    var i = 0
    function next() {
      if (i >= text.length) return Promise.resolve()
      caret.textContent = text.slice(0, ++i)
      return wait(text[i - 1] === ' ' ? 30 : 18, mine).then(next)
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
    return Promise.all([wait(ms, mine), during ? during(mine) : null]).then(function () {
      var took = still ? ms : Date.now() - started
      node.classList.add('done')
      if (took >= 900) node.insertAdjacentHTML('beforeend', '<small>' + (took / 1000).toFixed(1) + 's</small>')
    })
  }
  function load(src) {
    frame.setAttribute('src', src)
  }
  // In the app the game stays covered until the agent is done, with a "Watch anyway" link.
  // Here it is uncovered once it runs, so that the agent can be seen playing.
  function uncover() {
    cover.hidden = true
    empty.hidden = true
    frame.classList.add('on')
    run.textContent = '↻ Restart'
  }

  // ---------- the fox platformer, played by watching where the fox is ----------

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
  // Start the level, run along the ground through the first coins, with one hop on the way.
  function foxFirst(mine) {
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
      .then(function () { return tap('Space', 220, mine) })
      .then(function () { return until(function (p) { return p.x >= 530 }, mine) })
      .then(function () {
        key('keyup', 'ArrowRight')
        return wait(500, mine)
      })
  }
  // The double jump: up to the high ledge that one jump cannot reach.
  function foxDouble(mine) {
    key('keydown', 'ArrowRight')
    // Take off once clear of the low platform overhead, holding jump for its full height.
    return until(function (p) { return p.x >= 690 }, mine)
      .then(function () {
        key('keydown', 'Space')
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
      .then(function () { return until(function (p) { return p.vy > 0 }, mine, 1500) })
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
  // ---------- the scenes ----------

  var SCENES = [
    {
      id: 'web',
      label: 'Web game',
      name: 'fox-platformer',
      badge: 'Web game',
      device: 'Desktop ▾',
      caption: 'A demonstration using a real game made with Mirg.',
      play: '/demo/',
      turns: [
        {
          say: 'A side-scrolling platformer where a fox collects coins and avoids spikes. Three short levels.',
          think: 1300,
          steps: [
            ['Write index.html', 500],
            ['Write levels.js', 650],
            ['Write main.js', 1500],
            ['Run the game', 1300, function () { load('demo/index.html') }, function () { log.innerHTML = 'system&nbsp;&nbsp;&nbsp;Game running at http://127.0.0.1:52842/' }],
            ['Look at the game', 900, uncover],
            ['Playtest (7 inputs)', 1200, foxFirst]
          ],
          reply: 'Your platformer is running in the Game tab. I played the start of level 1 to check it: the fox runs, jumps and collects coins. <strong>Arrow keys</strong> to move, <strong>Space</strong> to jump.'
        },
        {
          say: 'Add a double jump',
          think: 900,
          steps: [['Edit main.js', 900], ['Playtest (6 inputs)', 1200, foxDouble]],
          reply: 'Done. Press jump again in mid-air for a second jump. I tested it: the fox reached a ledge it could not get to before.'
        }
      ]
    },
    {
      id: 'phone',
      label: 'iPhone and Android',
      name: 'fox-platformer',
      badge: 'Web game',
      device: 'iPhone 16 ▾',
      layout: 'phone',
      caption: 'The same game, made into a phone game and then an iPhone app. The Simulator picture is the one the agent took.',
      play: '/demo/?touch=1',
      start: function () {
        // This session starts from the finished desktop game.
        load('demo/index.html')
        uncover()
        log.innerHTML = 'system&nbsp;&nbsp;&nbsp;Game running at http://127.0.0.1:52842/'
      },
      turns: [
        {
          say: 'Make it work on phones with touch controls',
          think: 1100,
          steps: [
            ['Write index.html', 500],
            ['Edit main.js', 700],
            ['Preview as iPhone 16 (landscape)', 1000, function () {
              gameBox.classList.add('phone')
              load('demo/index.html?touch=1')
            }],
            ['Look at the game', 800],
            ['Playtest (6 inputs)', 1200, foxFirst]
          ],
          reply: 'Fox Run now plays on phones. I tested it in an iPhone preview held sideways: the ◀ ▶ buttons move the fox and JUMP jumps.'
        },
        {
          say: 'Turn this into an iOS app and run it in the iOS Simulator',
          think: 1000,
          steps: [
            ['Check mobile toolchains', 600],
            ['Set up mobile packaging', 1400],
            ['Build and run on iOS Simulator', 2600],
            ['Look at the iOS Simulator', 900, function () {
              $('m-window-title').textContent = 'iOS Simulator · iPhone 17'
              $('m-window-img').src = 'assets/ios-sim.png'
              $('m-window-img').alt = 'The game running in the iOS Simulator'
              gameBox.classList.add('behind')
              win.hidden = false
            }]
          ],
          reply: 'Fox Run is now an iOS app, running in the iOS Simulator. The Xcode project is in the <strong>ios/</strong> folder. Publishing to the App Store is your step, from Xcode.'
        }
      ]
    }
  ]

  // ---------- playing a scene ----------

  function reset(scene) {
    scroll.innerHTML = ''
    input.innerHTML = '<span class="m-placeholder">Describe what you want…</span>'
    send.classList.remove('ready', 'press')
    frame.classList.remove('on')
    frame.removeAttribute('src')
    gameBox.className = 'm-game'
    empty.hidden = false
    cover.hidden = true
    win.hidden = true
    run.textContent = '▶ Run'
    log.textContent = 'Game output and errors appear here.'
    $('m-name').textContent = scene.name
    $('m-badge').textContent = scene.badge
    $('m-device').textContent = scene.device
    $('demo-caption').textContent = scene.caption
    $('demo-play-link').querySelector('a').href = scene.play
  }

  function play(scene) {
    var mine = ++take
    current = scene
    reset(scene)
    if (scene.start) scene.start()
    var chain = wait(700, mine)
    scene.turns.forEach(function (turn, n) {
      chain = chain
        .then(function () { return type(turn.say, mine) })
        .then(function () { return submit(turn.say, mine) })
        .then(function () {
          // A new game is built behind the cover; a change to a running game is not.
          if (!frame.classList.contains('on')) {
            empty.hidden = true
            cover.hidden = false
          }
          return think(turn.think, mine)
        })
      turn.steps.forEach(function (step) {
        chain = chain.then(function () {
          // step: [title, shortest time, what happens as it starts or while it runs, what happens when it ends]
          var during = step[2]
          var result = during && during.length ? during : null
          if (during && !during.length) during()
          return tool(step[0], step[1], mine, result).then(function () {
            if (step[3]) step[3]()
          })
        })
      })
      chain = chain
        .then(function () {
          el('m-agent', turn.reply)
          return wait(n < scene.turns.length - 1 ? 2400 : 0, mine)
        })
    })
    chain.catch(function () {})
  }

  SCENES.forEach(function (scene, i) {
    var button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', i === 0 ? 'true' : 'false')
    button.textContent = scene.label
    button.addEventListener('click', function () {
      Array.prototype.forEach.call(picker.children, function (b) {
        b.setAttribute('aria-selected', b === button ? 'true' : 'false')
      })
      play(scene)
    })
    picker.appendChild(button)
  })
  $('demo-replay').addEventListener('click', function () {
    play(current || SCENES[0])
  })
  // Start when the demo scrolls into view, so nobody misses the beginning.
  if ('IntersectionObserver' in window) {
    var seen = new IntersectionObserver(
      function (entries) {
        if (entries[0].isIntersecting) {
          seen.disconnect()
          play(SCENES[0])
        }
      },
      { threshold: 0.3 }
    )
    seen.observe(wrap)
  } else {
    play(SCENES[0])
  }
})()
