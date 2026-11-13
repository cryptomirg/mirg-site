// mirg.ai/claim and mirg.ai/unsubscribe, opened from a Mirg email. The link carries the offer's
// token; pressing the button sends it to the database, which adds the credit (or stops the emails)
// for the account the email was sent to. Nothing happens until the button is pressed, so a mail
// program that opens links to check them cannot claim or unsubscribe by itself.
;(function () {
  var box = document.getElementById('offer')
  if (!box) return
  var RPC = 'https://dlnmbeqdtpyjkprkxfvt.supabase.co/rest/v1/rpc/'
  var KEY = 'sb_publishable_RTQ8CSTfuHByAw1-_bbqag_NX0-kQhp'
  var action = box.getAttribute('data-action')
  var token = (new URLSearchParams(location.search).get('t') || '').toLowerCase()
  var title = document.getElementById('offer-title')
  var text = document.getElementById('offer-text')
  var button = document.getElementById('offer-button')
  var note = document.getElementById('offer-note')

  // The token stays out of the address bar once read, so a screenshot or a shared link does not carry it.
  if (token && window.history && history.replaceState) history.replaceState(null, '', location.pathname)

  function done(heading, body, links) {
    title.textContent = heading
    text.textContent = body
    button.parentNode.innerHTML = links || ''
    note.textContent = ''
  }

  if (!/^[0-9a-f]{48}$/.test(token)) {
    done('This link is not complete', 'Open the link from the email again, or write to support@mirg.ai and we will sort it out.', '<a class="btn" href="mailto:support@mirg.ai">Email support</a>')
    return
  }

  function day(iso) {
    return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
  }

  button.addEventListener('click', function () {
    button.disabled = true
    note.textContent = action === 'claim' ? 'Adding it to your account…' : 'One moment…'
    fetch(RPC + (action === 'claim' ? 'mirg_claim_offer' : 'mirg_unsubscribe'), {
      method: 'POST',
      headers: { apikey: KEY, authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ p_token: token })
    })
      .then(function (r) {
        if (!r.ok) throw new Error('status ' + r.status)
        return r.json()
      })
      .then(function (result) {
        var open = '<a class="btn primary" href="/download">Download Mirg</a><a class="btn" href="/">Play games</a>'
        if (action === 'unsubscribe') {
          if (result === true) done('You will not get these emails again', 'Emails about your account, such as sign-in links and receipts, still arrive.', '<a class="btn" href="/">Back to mirg.ai</a>')
          else done('This link is not complete', 'Open the link from the email again, or write to support@mirg.ai.', '<a class="btn" href="mailto:support@mirg.ai">Email support</a>')
          return
        }
        var row = (result && result[0]) || {}
        // The credit in Mirg tokens: value_usd buys value_usd x 0.75 of AI cost, and $1 of cost is 125,000 tokens.
        var tokens = row.value_usd ? Math.round(row.value_usd * 0.75 * 125000) : 0
        var short = tokens >= 1e6 ? String(+(tokens / 1e6).toFixed(2)) + 'M' : String(+(tokens / 1e3).toFixed(1)) + 'K'
        var value = tokens ? short + ' free tokens' : 'Your free tokens'
        if (row.status === 'claimed') done(value + ' are on your account', 'They last until ' + day(row.until) + '. Open Mirg, signed in with the email address we wrote to, and describe a game. Settings shows them with your tokens.', open)
        else if (row.status === 'already') done('You already claimed this', row.until ? 'Your free tokens last until ' + day(row.until) + '. Open Mirg and describe a game.' : 'Open Mirg and describe a game.', open)
        else if (row.status === 'expired') done('This offer has ended', 'The link was good for 30 days. Write to support@mirg.ai if you still want to try Mirg with more free tokens.', '<a class="btn" href="mailto:support@mirg.ai">Email support</a>')
        else done('This link is not complete', 'Open the link from the email again, or write to support@mirg.ai and we will sort it out.', '<a class="btn" href="mailto:support@mirg.ai">Email support</a>')
      })
      .catch(function () {
        button.disabled = false
        note.textContent = 'That did not go through. Check your connection and try again.'
      })
  })
})()
