/* tc_telao | player.js — YouTube IFrame Player API dentro do browser CEF do MTA.
   Modos: (1) página local direta; (2) "bridge": esta mesma página hospedada por você em HTTPS e
   embutida via <iframe> pela página local (resolve embeds que exigem Referer válido). */
(function () {
  'use strict';
  var Q = {};
  location.search.replace(/^\?/, '').split('&').forEach(function (p) {
    var i = p.indexOf('='); if (i > 0) Q[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1));
  });
  var SID = Q.sid || '0', BRIDGE = Q.bridge || '', IS_CHILD = window.parent !== window;
  var ID_RE = /^[A-Za-z0-9_-]{11}$/;
  var ALLOWED = { ready: 1, meta: 1, ended: 1, error: 1, warn: 1, apitimeout: 1 };
  var $ = function (id) { return document.getElementById(id); };

  function emit(name, a, b, c) {
    var args = [a === undefined ? '' : a, b === undefined ? '' : b, c === undefined ? '' : c];
    if (IS_CHILD) { try { parent.postMessage({ tc: 1, kind: 'evt', name: name, args: args }, '*'); } catch (e) {} return; }
    try { if (window.mta && mta.triggerEvent) mta.triggerEvent('tc_telao:browser', name, SID, args[0], args[1], args[2]); } catch (e) {}
  }

  /* ---------- player local ---------- */
  var player = null, ready = false, apiState = 0, waiters = [], apiTimer = null, playTimer = null, hudTimer = null;
  var desiredPaused = false, autoFix = 0, forceMute = false, cur = { id: null, pos: 0 }, wantPause = false, vol = 60, lastState = -2, sentMeta = {}, testTimer = null, frames = 0;

  function setIdle(on, msg) { $('idle').classList.toggle('hidden', !on); if (msg) $('idleMsg').textContent = msg; }

  var apiTries = 0;
  function loadApiScript() {
    var old = document.getElementById('ytapi'); if (old) old.parentNode.removeChild(old);
    var sc = document.createElement('script');
    sc.id = 'ytapi'; sc.src = 'https://www.youtube.com/iframe_api';
    sc.onerror = function () {
      apiTries++;
      if (apiTries < 4) { setTimeout(loadApiScript, 2500); }
      else { apiState = 0; apiTries = 0; setIdle(true, 'Não carregou o iframe_api do YouTube'); emit('apitimeout', 'onerror'); }
    };
    document.head.appendChild(sc);
  }
  function withApi(cb) {
    if (window.YT && YT.Player) return cb();
    waiters.push(cb);
    if (apiState !== 0) return;
    apiState = 1; apiTries = 0;
    window.onYouTubeIframeAPIReady = function () {
      apiState = 2; clearTimeout(apiTimer);
      waiters.splice(0).forEach(function (f) { f(); });
    };
    loadApiScript();
    clearTimeout(apiTimer);
    apiTimer = setTimeout(function () { if (apiState !== 2) { apiState = 0; emit('apitimeout', 'timeout'); } }, 20000);
  }

  function startCur() {
    if (!ready || !cur.id) return;
    player.setVolume(vol);
    player.loadVideoById({ videoId: cur.id, startSeconds: cur.pos });
  }

  function makePlayer() {
    var pv = { autoplay: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, playsinline: 1 };
    if (location.protocol === 'http:' || location.protocol === 'https:') pv.origin = location.origin;
    player = new YT.Player('player', {
      width: '100%', height: '100%', playerVars: pv,
      host: Q.nc === '1' ? 'https://www.youtube-nocookie.com' : undefined,
      events: {
        onReady: function () { ready = true; startCur(); },
        onStateChange: onState,
        onError: function (e) {
          var m = 'Erro do YouTube ' + e.data;
          if (e.data === 153 || e.data === 150 || e.data === 101 || e.data === 152) m += ' (precisa da ponte HTTPS: Config.Player.bridgeUrl)';
          setIdle(true, m);
          if (cur.id) emit('error', cur.id, e.data);
        }
      }
    });
  }

  function onState(e) {
    var s = e.data; lastState = s;
    if (s === 1) {
      setIdle(false); $('pausebadge').classList.add('hidden');
      if (forceMute) { forceMute = false; setTimeout(function () { try { player.unMute(); player.setVolume(vol); } catch (e) {} }, 1500); }
      if (wantPause) { wantPause = false; player.pauseVideo(); player.seekTo(cur.pos, true); return; }
      if (cur.id && !sentMeta[cur.id]) {
        sentMeta[cur.id] = true;
        var d = player.getVideoData ? player.getVideoData() : {};
        emit('meta', cur.id, d.title || '', player.getDuration() || 0);
        showHud(d.title);
      }
    } else if (s === 2) {
      if (!desiredPaused && cur.id && autoFix < 2) {
        // pausou sozinho (autoplay bloqueado): recomeça mudo, o que o Chromium permite
        autoFix++; forceMute = true;
        try { player.mute(); player.playVideo(); } catch (e) {}
      } else { $('pausebadge').classList.remove('hidden'); }
    }
    else if (s === 0 && cur.id) { emit('ended', cur.id); }
  }

  function showHud(title) {
    if (!title) return;
    $('hudTitle').textContent = title;
    var h = $('hud'); h.classList.add('hidden'); void h.offsetWidth; h.classList.remove('hidden');
    clearTimeout(hudTimer); hudTimer = setTimeout(function () { h.classList.add('hidden'); }, 7000);
  }

  var impl = {
    play: function (id, pos, paused) {
      if (!ID_RE.test(id)) return;
      pos = Math.max(0, +pos || 0);
      var same = cur.id === id && ready && [1, 2, 3].indexOf(lastState) >= 0;
      cur.id = id; cur.pos = pos; wantPause = !!paused; desiredPaused = !!paused; autoFix = 0;
      if (same) {
        player.seekTo(pos, true);
        if (paused) player.pauseVideo(); else player.playVideo();
        return;
      }
      sentMeta[id] = false;
      setIdle(true, 'Carregando vídeo…');
      withApi(function () { if (!player) makePlayer(); else startCur(); });
      clearTimeout(playTimer);
      playTimer = setTimeout(function () {
        if (cur.id === id && !wantPause && lastState !== 1 && lastState !== 3) emit('warn', 'autoplay', lastState);
      }, 7000);
    },
    stop: function () {
      cur.id = null; wantPause = false; clearTimeout(playTimer);
      if (ready) { try { player.stopVideo(); } catch (e) {} }
      $('pausebadge').classList.add('hidden'); $('hud').classList.add('hidden');
      setIdle(true, 'Sem transmissão');
    },
    retry: function () {   // autoplay bloqueado: recomeça mudo (vídeo mudo sempre pode iniciar)
      if (!ready || !cur.id) return;
      forceMute = true; player.mute();
      player.loadVideoById({ videoId: cur.id, startSeconds: cur.pos });
      setTimeout(function () { try { player.playVideo(); } catch (e) {} }, 800);
    },
    volume: function (v) { vol = Math.max(0, Math.min(100, +v || 0)); if (ready) player.setVolume(vol); },
    sync: function (pos, paused, tol) {
      if (!ready || !cur.id) return;
      desiredPaused = !!paused;
      var s = player.getPlayerState();
      if (paused) {
        if (s === 1 || s === 3) player.pauseVideo();
        if (Math.abs(player.getCurrentTime() - pos) > 0.5) player.seekTo(pos, true);
        return;
      }
      if (s === 2 || s === 5) player.playVideo();
      if (s === 1 && Math.abs(player.getCurrentTime() - pos) > (+tol || 2.5)) player.seekTo(pos, true);
    },
    test: function (on) {
      var t = $('test'), was = !t.classList.contains('hidden');
      if (on === was) return;
      t.classList.toggle('hidden', !on);
      clearInterval(testTimer);
      if (on) {
        $('testInfo').textContent = 'Telão #' + SID;
        testTimer = setInterval(function () { frames++; $('clock').textContent = new Date().toLocaleTimeString() + '  •  ' + frames; }, 250);
      }
    }
  };

  /* ---------- ponte (opcional): página local embute a mesma página hospedada em HTTPS ---------- */
  var frame = null;
  if (BRIDGE && !IS_CHILD) {
    frame = document.createElement('iframe');
    frame.src = BRIDGE + (BRIDGE.indexOf('?') < 0 ? '?' : '&') + 'sid=' + encodeURIComponent(SID) + (Q.nc ? '&nc=' + Q.nc : '');
    frame.setAttribute('allow', 'autoplay; encrypted-media');
    frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;z-index:50';
    document.body.appendChild(frame);
  }
  window.addEventListener('message', function (ev) {
    var d = ev.data; if (!d || d.tc !== 1) return;
    if (IS_CHILD && ev.source === parent && d.kind === 'cmd' && impl[d.fn]) impl[d.fn].apply(null, d.args || []);
    else if (frame && ev.source === frame.contentWindow && d.kind === 'evt' && ALLOWED[d.name] && d.args) {
      var f = function (v) { return (typeof v === 'string' || typeof v === 'number') ? v : ''; };
      emit(d.name, f(d.args[0]), f(d.args[1]), f(d.args[2]));
    }
  });

  var TC = {};
  Object.keys(impl).forEach(function (fn) {
    TC[fn] = function () {
      var a = [].slice.call(arguments);
      if (frame) { try { frame.contentWindow.postMessage({ tc: 1, kind: 'cmd', fn: fn, args: a }, '*'); } catch (e) {} }
      else impl[fn].apply(null, a);
    };
  });
  window.TC = TC;

  function boot() { if (frame) return; /* no modo ponte, quem avisa 'ready' é a página filha */ setIdle(true, 'Sem transmissão'); emit('ready'); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
