// The play page: shows a game someone shared from Mirg, by the name in ?g=<name>.
// The game itself is served from a separate domain, so it never runs on mirg.ai.
;(function () {
  var PLAY_HOST = 'https://play.mirg.ai'
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
  // Who made it, if they picked a creator name: "Made with Mirg by @name", linking to their page.
  function credit() {
    var KEY = 'sb_publishable_RTQ8CSTfuHByAw1-_bbqag_NX0-kQhp'
    fetch('https://dlnmbeqdtpyjkprkxfvt.supabase.co/rest/v1/rpc/game_credit', {
      method: 'POST',
      headers: { apikey: KEY, authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ game: name })
    })
      .then(function (r) {
        return r.ok ? r.json() : []
      })
      .then(function (rows) {
        var who = rows && rows[0]
        if (!who || !/^[a-z0-9_]{3,20}$/.test(who.handle)) return
        var sub = document.getElementById('play-sub')
        sub.textContent = 'Made with Mirg by '
        var a = document.createElement('a')
        a.href = '/u/' + who.handle
        a.textContent = '@' + who.handle
        sub.appendChild(a)
      })
      .catch(function () {})
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
      credit()
      comments()
    })
    .catch(gone)
  // ---------- comments ----------
  var API = 'https://dlnmbeqdtpyjkprkxfvt.supabase.co'
  var CAPTCHA_KEY = '0x4AAAAAAFOZ0Roo6D6Ag9sT'
  var captchaWidget = null
  function ago(when) {
    var s = Math.max(1, Math.round((Date.now() - new Date(when).getTime()) / 1000))
    if (s < 60) return 'just now'
    var m = Math.round(s / 60)
    if (m < 60) return m + ' min ago'
    var h = Math.round(m / 60)
    if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago')
    var d = Math.round(h / 24)
    if (d < 30) return d + (d === 1 ? ' day ago' : ' days ago')
    return new Date(when).toLocaleDateString()
  }
  function commentItem(c) {
    var li = document.createElement('li')
    li.className = 'comment'
    var head = document.createElement('div')
    head.className = 'comment-head'
    var who = document.createElement('strong')
    who.textContent = c.name
    var when = document.createElement('span')
    when.className = 'comment-when'
    when.textContent = ago(c.created_at)
    var report = document.createElement('button')
    report.type = 'button'
    report.className = 'linklike comment-report'
    report.textContent = 'Report'
    report.addEventListener('click', function () {
      report.disabled = true
      report.textContent = 'Reported'
      fetch(API + '/functions/v1/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'report', id: c.id }) }).catch(function () {})
    })
    head.appendChild(who)
    head.appendChild(when)
    head.appendChild(report)
    var text = document.createElement('p')
    text.textContent = c.body
    li.appendChild(head)
    li.appendChild(text)
    return li
  }
  function captcha() {
    var box = document.getElementById('comment-captcha')
    function render() {
      if (captchaWidget !== null) return window.turnstile.reset(captchaWidget)
      captchaWidget = window.turnstile.render(box, { sitekey: CAPTCHA_KEY, theme: 'dark', size: 'flexible' })
    }
    if (window.turnstile) return render()
    var script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.onload = render
    document.head.appendChild(script)
  }
  function comments() {
    var section = document.getElementById('comments')
    var list = document.getElementById('comment-list')
    var empty = document.getElementById('comment-empty')
    var form = document.getElementById('comment-form')
    var status = document.getElementById('comment-status')
    var KEY = 'sb_publishable_RTQ8CSTfuHByAw1-_bbqag_NX0-kQhp'
    section.hidden = false
    fetch(API + '/rest/v1/rpc/game_comments', {
      method: 'POST',
      headers: { apikey: KEY, authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ game: name })
    })
      .then(function (r) {
        return r.ok ? r.json() : []
      })
      .then(function (rows) {
        list.textContent = ''
        rows.forEach(function (c) {
          list.appendChild(commentItem(c))
        })
        empty.hidden = rows.length > 0
      })
      .catch(function () {
        empty.hidden = false
      })
    // The "I am human" check loads once someone starts writing.
    form.addEventListener('focusin', captcha, { once: true })
    try {
      document.getElementById('comment-name').value = localStorage.getItem('mirg-comment-name') || ''
    } catch (e) {}
    form.addEventListener('submit', function (e) {
      e.preventDefault()
      var who = form.name.value.trim()
      var data = {
        slug: name,
        name: who,
        body: form.body.value,
        website: form.website.value,
        captcha: window.turnstile && captchaWidget !== null ? window.turnstile.getResponse(captchaWidget) : ''
      }
      status.className = 'comment-status'
      status.textContent = 'Posting…'
      fetch(API + '/functions/v1/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
        .then(function (r) {
          return r.json().then(function (body) {
            return { ok: r.ok, body: body }
          })
        })
        .then(function (res) {
          if (window.turnstile && captchaWidget !== null) window.turnstile.reset(captchaWidget)
          if (!res.ok) {
            status.className = 'comment-status error'
            status.textContent = (res.body && res.body.error) || 'That did not post. Please try again.'
            return
          }
          try {
            localStorage.setItem('mirg-comment-name', who)
          } catch (e) {}
          form.body.value = ''
          status.textContent = 'Posted.'
          if (res.body.comment) {
            list.insertBefore(commentItem(res.body.comment), list.firstChild)
            empty.hidden = true
          }
        })
        .catch(function () {
          status.className = 'comment-status error'
          status.textContent = 'That did not post. Check your connection and try again.'
        })
    })
  }

  // Full screen: real full screen on computers; on phones the game fills the window instead.
  var box = document.getElementById('play-frame')
  var exit = document.getElementById('play-exit')
  function fill(on) {
    box.classList.toggle('filled', on)
    document.documentElement.classList.toggle('play-filled', on)
    exit.hidden = !on
  }
  document.getElementById('play-full').addEventListener('click', function () {
    // Phones and tablets: fill the screen with the page itself. iPhones report a full screen
    // command but it only works for videos, so it would silently do nothing.
    if (matchMedia('(pointer: coarse)').matches || !(box.requestFullscreen || box.webkitRequestFullscreen)) return fill(true)
    try {
      var started = box.requestFullscreen ? box.requestFullscreen() : box.webkitRequestFullscreen()
      if (started && started.catch) started.catch(function () { fill(true) })
    } catch (e) {
      return fill(true)
    }
    // If the browser accepted the command but did not go full screen, fill the window instead.
    setTimeout(function () {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) fill(true)
    }, 600)
  })
  exit.addEventListener('click', function () { fill(false) })
})()
