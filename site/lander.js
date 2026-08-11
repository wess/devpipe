(function () {
  'use strict';

  var body = document.getElementById('body');
  var term = document.getElementById('term');
  var away = document.getElementById('away');
  var awaySecs = document.getElementById('awaySecs');
  var resumed = document.getElementById('resumed');
  var uptimeEl = document.getElementById('uptime');

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // A plausible run, not a highlight reel. The point of the demo is that it
  // is unremarkable work continuing, not a dramatic finale.
  var script = [
    { t: 'dim',  s: '$ claude' },
    { t: '',     s: 'Reading src/auth/session.rs' },
    { t: '',     s: 'Reading src/auth/token.rs' },
    { t: 'amb',  s: '· refactoring token refresh' },
    { t: 'ok',   s: '✓ src/auth/token.rs — 41 lines changed' },
    { t: '',     s: 'Running cargo test --package auth' },
    { t: 'dim',  s: '  running 18 tests' },
    { t: 'warn', s: '✗ token::refresh_before_expiry — assertion failed' },
    { t: 'amb',  s: '· reading the failure' },
    { t: 'ok',   s: '✓ src/auth/token.rs — clamped the skew window' },
    { t: '',     s: 'Running cargo test --package auth' },
    { t: 'ok',   s: '✓ 18 passed, 0 failed' },
    { t: 'amb',  s: '· writing a regression test for the skew' },
    { t: 'ok',   s: '✓ tests/token_skew.rs — 34 lines' },
    { t: '',     s: 'Running cargo test --workspace' },
    { t: 'dim',  s: '  compiling 31 crates' },
    { t: 'ok',   s: '✓ 214 passed, 0 failed' },
    { t: 'amb',  s: '· committing on branch auth/token-skew' },
    { t: 'ok',   s: '✓ 3 files changed, 79 insertions' }
  ];

  var cls = { '': '', dim: 't-dim', ok: 't-ok', amb: 't-amb', warn: 't-warn' };
  var MAX_LINES = 13;
  var idx = 0;
  var started = Date.now();
  var linesWhileAway = 0;
  var isAway = false;

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function tickUptime() {
    var s = Math.floor((Date.now() - started) / 1000);
    uptimeEl.textContent =
      pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  }

  function addLine() {
    var item = script[idx % script.length];
    idx++;
    var el = document.createElement('span');
    if (cls[item.t]) el.className = cls[item.t];
    el.textContent = item.s;
    body.appendChild(el);
    while (body.childElementCount > MAX_LINES) body.removeChild(body.firstChild);
    if (isAway) linesWhileAway++;
  }

  // The caret lives on the last line so the pane reads as live rather than as
  // a static screenshot.
  function moveCaret() {
    var old = body.querySelector('.caret');
    if (old) old.remove();
    var last = body.lastElementChild;
    if (!last) return;
    var caret = document.createElement('i');
    caret.className = 'caret';
    last.appendChild(document.createTextNode(' '));
    last.appendChild(caret);
  }

  if (reduced) {
    // Show the end state and stop. No looping, no counters climbing.
    for (var i = 0; i < MAX_LINES; i++) addLine();
    moveCaret();
    tickUptime();
    resumed.textContent = 'Sessions keep running while you are disconnected.';
    resumed.classList.add('show');
    return;
  }

  setInterval(tickUptime, 1000);
  tickUptime();

  // Start mid-session. An empty pane filling from the bottom reads as broken
  // for the first ten seconds, and the premise is a machine that has been
  // working for a while already — not one that just booted.
  for (var pre = 0; pre < 9; pre++) addLine();
  moveCaret();

  function loop() {
    addLine();
    moveCaret();
    // Uneven cadence: a real agent thinks for different amounts of time.
    var wait = 620 + Math.random() * 900;
    setTimeout(loop, wait);
  }
  loop();

  // The disconnect cycle. Everything above keeps running through it, which is
  // the only claim this page is making.
  function goAway() {
    isAway = true;
    linesWhileAway = 0;
    var awayStart = Date.now();
    term.classList.add('away');
    away.classList.add('show');
    resumed.classList.remove('show');

    var counter = setInterval(function () {
      awaySecs.textContent = Math.round((Date.now() - awayStart) / 1000) + 's';
    }, 250);
    awaySecs.textContent = '0s';

    setTimeout(function () {
      clearInterval(counter);
      var elapsed = Math.round((Date.now() - awayStart) / 1000);
      isAway = false;
      term.classList.remove('away');
      away.classList.remove('show');
      resumed.innerHTML =
        'Reconnected after ' + elapsed + 's · <b>' + linesWhileAway +
        ' lines</b> arrived while you were gone.';
      resumed.classList.add('show');
      setTimeout(goAway, 13000);
    }, 6000);
  }
  setTimeout(goAway, 7000);

  // ---- claiming a username -------------------------------------------

  var form = document.getElementById('form');
  var username = document.getElementById('username');
  var email = document.getElementById('email');
  var submit = document.getElementById('submit');
  var note = document.getElementById('note');
  var availability = document.getElementById('availability');

  var checkTimer = null;
  var lastChecked = '';

  function setAvailability(text, state) {
    availability.textContent = text;
    availability.className = 'availability' + (state ? ' ' + state : '');
  }

  // Debounced: a check per keystroke would be a request per keystroke, and the
  // answer only matters once someone stops typing.
  username.addEventListener('input', function () {
    var value = username.value.trim().toLowerCase();
    username.value = value;
    clearTimeout(checkTimer);
    if (value.length < 3) { setAvailability('', ''); return; }
    setAvailability('checking…', '');
    checkTimer = setTimeout(function () {
      lastChecked = value;
      fetch('/api/claims/check?username=' + encodeURIComponent(value))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          // A slow answer for a name already typed past is worse than none.
          if (username.value.trim().toLowerCase() !== lastChecked) return;
          if (d.available) setAvailability('@' + value + ' is free', 'free');
          else setAvailability(d.reason || 'That username is taken.', 'taken');
        })
        .catch(function () { setAvailability('', ''); });
    }, 350);
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = username.value.trim().toLowerCase();
    var address = email.value.trim();
    note.className = 'form-note';

    if (name.length < 3) {
      note.textContent = 'Pick a username of at least three characters.';
      note.classList.add('bad');
      username.focus();
      return;
    }
    if (!address || address.indexOf('@') < 1 || address.indexOf('.', address.indexOf('@')) < 0) {
      note.textContent = 'That address is missing something — check for a typo.';
      note.classList.add('bad');
      email.focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Claiming';

    fetch('/api/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, email: address })
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, body: d }; });
    }).then(function (res) {
      if (!res.ok) throw new Error(res.body && res.body.error ? res.body.error : 'That did not work.');
      form.style.display = 'none';
      setAvailability('', '');
      note.textContent = '@' + name + ' is yours. We will write once, when there is something to log into.';
      note.classList.add('ok');
    }).catch(function (err) {
      note.textContent = err.message;
      note.classList.add('bad');
      submit.disabled = false;
      submit.textContent = 'Claim it';
    });
  });
})();
