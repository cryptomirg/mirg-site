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
