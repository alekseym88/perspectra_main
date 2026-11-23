(() => {
  'use strict';
  if (Date.now() >= Date.parse('2026-11-28T00:00:00+08:00')) document.body.dataset.launchOffer = 'false';
  const assets = new URL('.', document.currentScript.src);
  const url = name => new URL(name, assets).href;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const loads = new Map();
  const script = (name, refresh=false) => {
    if (name === 'three-r160.min.js' && window.THREE) return Promise.resolve();
    if (refresh) loads.delete(name);
    if (!loads.has(name)) loads.set(name, new Promise((resolve, reject) => {
      const el = document.createElement('script'); el.src = url(name) + (refresh ? '?v=' + Date.now() : '');
      el.onload = () => { el.remove(); resolve(); };
      el.onerror = () => { el.remove(); loads.delete(name); reject(new Error('Could not load ' + name)); };
      document.head.append(el);
    }));
    return loads.get(name);
  };
  const playerReady = player => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview loading timed out. Please retry.')), 45000);
    player.addEventListener('preview-error', e => { clearTimeout(timer); reject(e.detail); }, { once: true });
    player.addEventListener('ready', () => {
      const v = player.shadowRoot.querySelector('video');
      const done = () => {
        if (v.seeking) { v.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once:true }); }
        else { clearTimeout(timer); resolve(); }
      };
      if (v.readyState >= 2) done(); else v.addEventListener('loadeddata', done, { once: true });
      v.addEventListener('error', () => { clearTimeout(timer); reject(new Error('The footage could not load.')); }, { once: true });
    }, { once: true });
  });
  async function viewer(name, video, poster, mount, state = {}) {
    await script('three-r160.min.js');
    await script('track-preview.js?v=f6ca2e3d05');
    const p = document.createElement('perspectra-preview');
    p.hidden = !!state.hidden;
    if (state.automatic) p.fullscreenTarget = $('#automatic-stage');
    // Footage loads only on selection. Blobs allow seeking on hosts without byte ranges.
    let footageURL = null;
    if (/^https?:/.test(video)) {
      const response = await fetch(video);
      if (!response.ok) throw new Error('The preview footage could not load.');
      footageURL = URL.createObjectURL(await response.blob());
      video = footageURL;
      p.addEventListener('preview-dispose', () => URL.revokeObjectURL(footageURL), { once: true });
    }
    const sceneURL = URL.createObjectURL(new Blob([JSON.stringify(name)], { type: 'application/json' }));
    p.setAttribute('src', sceneURL); p.setAttribute('video', video); p.setAttribute('poster', poster);
    p.setAttribute('frame', String(state.frame || name.frames.start));
    if (state.mode) p.setAttribute('mode', state.mode);
    if (name.preset) p.setAttribute('automatic', '');
    const ready = playerReady(p); mount.append(p);
    try { await ready; } catch(e) { p.remove(); if (footageURL) URL.revokeObjectURL(footageURL); throw e; } finally { URL.revokeObjectURL(sceneURL); }
    if (state.orbit) {
      const {target, ...angles} = state.orbit;
      Object.assign(p.rig, angles); p.rig.target.copy(target); p.rig.apply();
    }
    const anchor = name.cubeAnchor;
    if (anchor && state.cube === undefined) {
      const V = window.THREE.Vector3;
      state.cube = {corner: new V(...anchor.corner), up: new V(...(anchor.up || [0, 0, 1])), ax0: new V(...(anchor.axis || [1, 0, 0])),
        size: anchor.size, measured: true, rot: 0, where: 'Measured scene point · frames ' + anchor.frame + '–' + anchor.last};
    }
    if (state.cube) {
      p.cube = {...state.cube, corner:state.cube.corner.clone(), up:state.cube.up.clone(), ax0:state.cube.ax0.clone()};
      p.s3.setCube(p.cube); p._cubeBtn();
      const scale=p.$('.c-size');
      scale.min = Math.min(Number(scale.min), p.cube.size);
      scale.max = Math.max(Number(scale.max), p.cube.size);
      scale.step = 'any';
      scale.value = p.cube.size;
      p.$('.c-rot').value = window.THREE.MathUtils.radToDeg(p.cube.rot);
      p.$('.c-size').dispatchEvent(new Event('input'));
      p.$('.cube-pop .where').textContent = p.cube.where;
    }
    return p;
  }
  function pauseOthers(except) {
    $$('video').filter(v => v !== except).forEach(v => v.pause());
    $$('perspectra-preview').filter(p => p !== except).forEach(p => p.pause());
  }

  // Decorative motion only: no scroll-bound transitions and no changes to demo footage.
  const hero = $('.hero');
  // Always on by default, as requested. Honor OS reduced motion and suspend
  // work only while the banner is outside the viewport or the tab is hidden.
  let heroVisible = true;
  function updateHeroMotion() {
    hero.classList.toggle('motion-paused', !heroVisible || document.hidden);
  }
  document.addEventListener('visibilitychange', updateHeroMotion);
  new IntersectionObserver(entries => { heroVisible = entries[0].isIntersecting; updateHeroMotion(); }).observe(hero);
  updateHeroMotion();

  // The gallery uses the same manifest as the published queue results.
  // Keeping labels, original downloads and availability together avoids a second clip list.
  const catalog = window.PerspectraManifest || [];
  const clips = catalog.map(entry => [entry.id, entry.title, entry.source, Number(entry.fps.toFixed(3))]);
  const entryFor = id => window.PerspectraManifest?.find(entry => entry.id === id);
  // Each example has one selected camera result. Do not silently
  // substitute another mode when the chosen result is absent or fails to load.
  const selectedResult = entry => ['fast', 'normal', 'saved', 'refined'].includes(entry?.selectedMode) && entry.modes?.[entry.selectedMode]?.ready ? entry.modes[entry.selectedMode] : null;
  const durationLabel = entry => Number((entry?.presentation?.playback.duration ?? entry?.duration)?.toFixed(1)) + 's';
  const requestedClip = new URLSearchParams(location.search).get('clip');
  const readyClips = clips.filter(c => selectedResult(entryFor(c[0])));
  let clip = readyClips.find(c => c[0] === requestedClip) || readyClips[0] || clips[0];
  let active = null, automaticStarted = false, sequence = 0;
  let cameraMode = entryFor(clip[0]).selectedMode;
  const remembered = new Map();
  const stateKey = () => clip[0] + '/' + cameraMode;
  const cameraLabel = (entry, mode) => mode === 'refined' ? 'Refined camera' : mode === 'saved' ? 'Saved Blender camera' :
    mode === 'normal' && entry.provisionalNormal ? 'Normal · first lens candidate' :
    mode === 'normal' ? 'Normal' : 'Fast';
  const saveState = (remove = true) => {
    if (!active) return;
    remembered.set(stateKey(), { time: active.pb.v.currentTime, mode: active.mode,
      cube:active.cube ? {...active.cube, corner:active.cube.corner.clone(), up:active.cube.up.clone(), ax0:active.cube.ax0.clone()} : null,
      orbit: active.rig ? {
      target: active.rig.target.clone(), az: active.rig.az, el_: active.rig.el_, r: active.rig.r
    } : null });
    active.pause();
    if (remove) { active.remove(); active = null; }
  };
  function updateSelection() {
    const entry = entryFor(clip[0]), ready = !!selectedResult(entry);
    const seconds = selectedResult(entry)?.processingSeconds;
    const minutes = Math.round(seconds / 60);
    const runtime = minutes >= 60 ? Math.floor(minutes / 60) + ' h ' + minutes % 60 + ' min' : minutes + ' min';
    $('#clip-detail').hidden = !ready;
    $('#clip-mode').textContent = cameraLabel(entry, cameraMode);
    $('#clip-runtime').hidden = !Number.isFinite(seconds);
    $('#clip-runtime dd').textContent = Number.isFinite(seconds) ? '≈ ' + runtime : '';
    $('#clip-detail-status').hidden = ready;
    $('#clip-detail-status').textContent = 'Tracking preview pending';
    $('#launch-automatic').disabled = !ready;
    $('#launch-automatic').lastElementChild.textContent = ready ? 'Track video' : 'Tracking preview pending';
    const original = $('#clip-original');
    const { provider } = entry.original;
    original.href = url(entry.original.url);
    if (provider) {
      original.querySelector('span').textContent = 'Original video · ' + provider;
      original.setAttribute('aria-label', 'Original video · ' + provider + ' (' + entry.title + ', opens in a new tab)');
      original.target = '_blank';
      original.rel = 'noopener';
      original.removeAttribute('download');
    } else {
      original.querySelector('span').textContent = 'Download original video';
      original.setAttribute('aria-label', 'Download original video for ' + entry.title);
      original.download = entry.source;
      original.removeAttribute('target');
    }
    const context = ready ? entry.galleryNote : null;
    $('.gallery-context').hidden = !context;
    $('#gallery-context-title').textContent = context?.title || '';
    $('#clip-inspect').textContent = context?.text || '';
    $('#clip-poster').src = url(clip[0] + '-poster.webp');
    $('#clip-poster').alt = clip[1] + ' source footage';
    $$('[data-clip]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.clip === clip[0])));
  }
  const clipTrack = $('#tracking-clips');
  for (const c of clips) {
    const entry = entryFor(c[0]);
    const button = document.createElement('button'); button.dataset.clip = c[0]; button.type = 'button';
    const coverage = selectedResult(entry) ? (entry.coverage === 'full' ? (entry.presentation?.playback.trimmedEndFrames ? 'Trimmed · ' : '') + durationLabel(entry) : 'Preview · 6s') : 'Preview pending';
    button.setAttribute('aria-label', c[1] + ' camera tracking example, ' + coverage);
    button.title = c[1] + ' · ' + coverage;
    const portrait = entry.orientation === 'portrait';
    const img = document.createElement('img'); img.src = url(c[0] + (portrait ? '-poster.webp' : '-thumb.webp')); img.width = portrait ? 619 : 300; img.height = portrait ? 1100 : 170; img.alt = ''; img.loading = 'lazy';
    const label = document.createElement('span'); label.textContent = c[1];
    const badge = document.createElement('small'); badge.className = 'clip-status'; badge.textContent = coverage;
    button.append(img, label, badge);
    button.addEventListener('click', () => {
      if (clip === c) return;
      saveState(); clip = c; cameraMode = entry.selectedMode; updateSelection(); sequence++;
      $('#automatic-message').hidden = true; $('#automatic-cover').hidden = false;
      if (automaticStarted && selectedResult(entry)) loadAutomatic();
    });
    button.classList.toggle('portrait-clip', portrait);
    clipTrack.append(button);
  }
  for (const clipCatalog of $$('[data-clip-rail]')) {
    const track = clipCatalog.firstElementChild;
    const previousClips = clipCatalog.querySelector('.previous');
    const nextClips = clipCatalog.querySelector('.next');
    function updateClipArrows() {
      const remaining = track.scrollWidth - track.clientWidth - track.scrollLeft;
      previousClips.hidden = track.scrollLeft <= 1;
      nextClips.hidden = remaining <= 1;
    }
    function pageClips(direction) {
      const gap = parseFloat(getComputedStyle(track).columnGap);
      const stride = track.firstElementChild.getBoundingClientRect().width + gap;
      const columns = Math.max(1, Math.floor((track.clientWidth + gap) / stride));
      track.scrollBy({
        left: direction * columns * stride,
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
      });
    }
    previousClips.addEventListener('click', () => pageClips(-1));
    nextClips.addEventListener('click', () => pageClips(1));
    track.addEventListener('scroll', updateClipArrows, {passive: true});
    new ResizeObserver(updateClipArrows).observe(track);
    updateClipArrows();
  }
  async function loadAutomatic() {
    automaticStarted = true;
    saveState(false);
    const ticket = ++sequence, current = clip, launch = $('#launch-automatic');
    const focusedPlayer = active && document.activeElement === active;
    $('#automatic-cover').hidden = !!active; $('#automatic-message').hidden = true;
    launch.disabled = true; launch.lastElementChild.textContent = 'Loading tracking data…';
    let created;
    try {
      const entry = entryFor(current[0]);
      const mode = cameraMode, result = entry.modes[mode];
      if (!result) throw new Error('The tracking preview for this clip is not available yet. Choose another example.');
      await script(result.script);
      if (ticket !== sequence) return;
      const data = {...window.PerspectraScenes[current[0] + '-' + mode], presentation:entry.presentation};
      const saved = remembered.get(stateKey()) || {};
      pauseOthers();
      created = await viewer(data, url(result.video || entry.video || current[0] + '.mp4'), url(current[0] + '-poster.webp'), $('#automatic-viewer'), {
        frame: saved.time != null ? Math.floor(saved.time * data.video.fps) + data.video.clipStart : (data.cubeAnchor?.frame || data.frames.start), mode: saved.mode, orbit: saved.orbit, cube:saved.cube,
        hidden: true, automatic: true
      });
      if (ticket !== sequence) { created.remove(); return; }
      active?.remove(); active = created; active.hidden = false;
      $('#automatic-cover').hidden = true;
      if (focusedPlayer || document.activeElement === launch) active.shadowRoot.querySelector('.play').focus({ preventScroll: true });
    } catch (e) {
      if (ticket === sequence) {
        $('#automatic-message').textContent = e.message; $('#automatic-message').hidden = false;
      }
    } finally {
      if (ticket === sequence) { launch.disabled = false; launch.lastElementChild.textContent = active ? 'Track video' : 'Retry camera preview'; }
    }
  }
  $('#launch-automatic').addEventListener('click', () => loadAutomatic());
  updateSelection();

  let manual = null;
  $('#launch-manual').addEventListener('click', async event => {
    const button = event.currentTarget; if (button.disabled) return;
    button.disabled = true; button.lastElementChild.textContent = 'Loading corrected scene…'; $('#manual-message').hidden = true;
    let videoURL;
    try {
      await script('repair-export.js?v=recovered-64992');
      const data = window.perspectraTrackExport;
      const bytes = Uint8Array.from(atob(data.footage), ch => ch.charCodeAt(0));
      videoURL = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
      pauseOthers();
      const references = JSON.parse(data.scene);
      await script(entryFor('garage').modes.fast.script);
      references.traceColor = [1,.61,.16];
      references.rawCamera = window.PerspectraScenes['garage-fast'].camera;
      references.meshes = [];
      delete references.cloud;
      manual = await viewer(references, videoURL, data.poster, $('#manual-viewer'), { frame: 601 });
      manual.addEventListener('preview-dispose', () => URL.revokeObjectURL(videoURL), { once: true });
      $('#manual-cover').hidden = true;
      if (document.activeElement === button) manual.shadowRoot.querySelector('.play').focus({ preventScroll: true });
    } catch(e) {
      if (videoURL) URL.revokeObjectURL(videoURL);
      $('#manual-message').textContent = 'The corrected preview could not load. ' + e.message; $('#manual-message').hidden = false;
      button.lastElementChild.textContent = 'Retry corrected track';
    } finally { button.disabled = false; }
  });

  for (const section of $$('[data-comparison]')) {
    const cover = section.querySelector('.demo-cover');
    const launch = cover.querySelector('button');
    const mount = section.querySelector('.comparison-viewer');
    const message = section.querySelector('[role=status]');
    const controls = section.querySelector('.pose-display');
    let current = null, sequence = 0;
    async function inspect() {
      const ticket = ++sequence;
      const kind = section.dataset.comparison;
      const variant = section.querySelector('input:checked').value;
      const key = 'feature-' + kind + '-' + variant;
      const frame = current?.pb.shown;
      const mode = current?.mode ?? (kind === 'rig' ? 'overview' : 'camera');
      const resume = current?.pb.playing;
      current?.pause();
      launch.disabled = true;
      message.hidden = true;
      try {
        await script(key + '.js?v=' + (kind === 'rig' ? 'landmarks-1' : 'motion-review-3'));
        if (ticket !== sequence) return;
        const data = {...window.PerspectraExamples[key], comparison:kind, variant};
        if (kind === 'rig') {
          await script(entryFor('sports_car').modes.normal.script);
          const analysis = window.PerspectraScenes['sports_car-normal'];
          data.health = analysis.health;
          data.rows = {...data.rows, quality:data.rows.frames.map(f => analysis.health.q[f - analysis.frames.start])};
          data.show = {...data.show, health:true};
          data.healthReference = 'Normal analysis';
        }
        const player = await viewer(data, url(section.dataset.footage), url(section.dataset.poster),
          mount, {frame: frame ?? data.frames.start, mode, hidden:true});
        if (ticket !== sequence) { player.remove(); return; }
        player.append(controls);
        controls.hidden = false;
        current?.remove();
        current = player;
        current.dataset.variant = variant;
        cover.hidden = true;
        player.hidden = false;
        pauseOthers(player);
        if (resume) player.pb.play();
        if (document.activeElement === launch) player.shadowRoot.querySelector('.play').focus({preventScroll:true});
      } catch (error) {
        if (ticket === sequence) {
          message.textContent = 'Could not load the comparison. ' + error.message;
          message.hidden = false;
          if (current) section.querySelector('input[value="' + current.dataset.variant + '"]').checked = true;
        }
      } finally {
        if (ticket === sequence) launch.disabled = false;
      }
    }
    launch.addEventListener('click', inspect);
    section.addEventListener('change', event => {
      if (!event.target.matches('fieldset input[type="radio"]')) return;
      for (const radio of section.querySelectorAll('fieldset input[type="radio"]')) {
        radio.checked = radio.value === event.target.value;
      }
      inspect();
    });
  }

  const scans = $('.scan-gallery');
  if (scans) {
    const canvas = scans.querySelector('canvas'), source = scans.querySelector('video');
    const message = scans.querySelector('[role=status]'), launch = scans.querySelector('.play-launch');
    const reset = scans.querySelector('[data-reset]');
    let orbit, loaded, sequence = 0;
    async function showScan() {
      const ticket = ++sequence;
      const item = scans.querySelector('[data-scan][aria-pressed=true]');
      const key = item.dataset.scan, folder = 'scans/' + key + '/';
      const isMesh = scans.querySelector('[name=scan-view]:checked').value === 'mesh';
      scans.querySelector('.scan-cover').hidden = true;
      const original = scans.querySelector('.media-links a');
      original.href = url(item.dataset.original);
      original.textContent = 'Download original ' + key + ' video';
      source.pause();
      source.poster = item.querySelector('img').src;
      if (source.getAttribute('src') !== url(item.dataset.source)) source.src = url(item.dataset.source);
      source.hidden = isMesh;
      canvas.hidden = !isMesh;
      reset.hidden = !isMesh;
      launch.hidden = true;
      message.textContent = isMesh ? 'Loading mesh…' : '';
      if (!isMesh) return;
      try {
        if (loaded !== key) {
          await Promise.all([script('three-r160.min.js'),script('scan-viewer.js'),script(folder+'mesh.js?v=turntables-4')]);
          if (ticket !== sequence) return;
          const texture = await new THREE.TextureLoader().loadAsync(window.PerspectraScans[key].texture);
          if (ticket !== sequence) { texture.dispose(); return; }
          orbit ??= new window.PerspectraScanViewer(canvas);
          orbit.setModel(window.PerspectraScans[key],texture);
          loaded = key;
        } else orbit.draw();
        message.textContent = 'Drag to orbit. Scroll to zoom, or use the arrow and + / − keys.';
      } catch (error) {
        if (ticket !== sequence) return;
        canvas.hidden = reset.hidden = true;
        source.hidden = false;
        scans.querySelector('[value=source]').checked = true;
        message.textContent = 'The 3D view could not load. Showing the source footage.';
      }
    }
    for (const card of scans.querySelectorAll('[data-scan]')) card.addEventListener('click', () => {
      for (const other of scans.querySelectorAll('[data-scan]')) other.setAttribute('aria-pressed', String(card === other));
      showScan();
    });
    scans.querySelector('fieldset').addEventListener('change',showScan);
    reset.addEventListener('click',() => orbit?.reset());
    launch.addEventListener('click',showScan);
  }

  const poseGallery = $('.pose-gallery');
  const modelControls = $('#pose-controls-template').content.querySelector('fieldset');
  const poseCover = poseGallery.querySelector('.demo-cover');
  const poseLaunch = poseCover.querySelector('button');
  const poseMount = poseGallery.querySelector('.comparison-viewer');
  const poseMessage = poseGallery.querySelector('[role=status]');
  let posePlayer, poseTicket = 0;
  async function inspectPose(button, launchOverview = false) {
    const ticket = ++poseTicket;
    const key = button.dataset.pose;
    const folder = 'full/' + key + '/';
    const hands = button.hasAttribute('data-hands');
    const bonesChoice = modelControls.querySelector('#model-bones');
    modelControls.querySelector('label[for=model-mixamo] span').textContent = 'Maximo';
    bonesChoice.parentElement.hidden = hands;
    if (hands && bonesChoice.checked) modelControls.querySelector('#model-anny').checked = true;
    const display = modelControls.querySelector('[name=pose-model]:checked').value;
    const model = display === 'mixamo' ? 'mixamo' : 'anny';
    const fittedYBot = display === 'mixamo' && ['pose-6868294', 'pose-21827'].includes(key);
    const maleAnny = display === 'anny' && key === 'pose-21827';
    const templateFile = {anny:maleAnny ? 'human-body-anny-male.js' : 'human-body-anny.js', mixamo:fittedYBot ? 'human-ybot-fit.js' : 'human-ybot.js', bones:'human-bones.js'}[display];
    const sameClip = posePlayer?.dataset.clip === key;
    const previousFrame = sameClip ? posePlayer.pb.shown : null;
    const mode = sameClip ? posePlayer.mode : launchOverview ? 'overview' : 'camera';
    const resume = sameClip && posePlayer.pb.playing;
    const rig = sameClip && posePlayer.rig;
    const orbit = rig ? {target:rig.target.clone(), az:rig.az, el_:rig.el_, r:rig.r} : null;
    posePlayer?.pause();
    poseCover.hidden = !!posePlayer;
    if (!launchOverview) poseCover.querySelector('img').src = button.querySelector('img').src;
    for (const card of poseGallery.querySelectorAll('[data-pose]')) card.setAttribute('aria-pressed', String(card === button));
    poseMessage.hidden = true;
    poseLaunch.disabled = true;
    try {
      await Promise.all([
        hands ? Promise.resolve() : script(templateFile + '?v=human-display-3'),
        script(folder + (model === 'anny' ? 'scene.js' : 'mixamo.js') + (hands ? '?v=a1a4cefe1c' : '?v=4d923e5781a6'))
      ]);
      if (ticket !== poseTicket) return;
      const scene = {...window.PerspectraExamples[key + '-' + model], poseDisplay:display, poseDisplayTemplate:maleAnny ? 'anny-male' : fittedYBot ? 'ybot-fit' : undefined};
      const first = Number(launchOverview ? poseCover.querySelector('img').dataset.overviewFrame : button.dataset.posterFrame);
      const player = await viewer(scene, url(folder + 'source.mp4?v=' + scene.video.clipStart + '-' + scene.video.frames), button.querySelector('img').src, poseMount,
        {mode, frame:previousFrame ?? first, orbit, hidden:true});
      if (ticket !== poseTicket) { player.remove(); return; }
      modelControls.slot = 'model-controls';
      player.append(modelControls);
      posePlayer?.remove();
      posePlayer = player;
      player.dataset.clip = key;
      poseCover.hidden = true;
      player.hidden = false;
      pauseOthers(player);
      if (resume) player.pb.play();
      if (document.activeElement === poseLaunch) player.shadowRoot.querySelector('.play').focus({preventScroll:true});
    } catch (error) {
      if (ticket === poseTicket) {
        if (posePlayer) {
          modelControls.querySelector('[name=pose-model][value="'+posePlayer.d.j.poseDisplay+'"]').checked = true;
          for (const card of poseGallery.querySelectorAll('[data-pose]')) card.setAttribute('aria-pressed', String(card.dataset.pose === posePlayer.dataset.clip));
        }
        poseMessage.hidden = false;
        poseMessage.textContent = 'Could not load this body. ' + error.message;
      }
    } finally {
      if (ticket === poseTicket) poseLaunch.disabled = false;
    }
  }
  poseLaunch.addEventListener('click', () => {
    const card = poseGallery.querySelector('[data-pose][aria-pressed="true"]');
    inspectPose(card, poseCover.querySelector('img').src.includes('/pose-overview.webp'));
  });
  for (const button of poseGallery.querySelectorAll('[data-pose]')) button.addEventListener('click', () => inspectPose(button));
  function openLinkedPose() {
    const card = Array.from(poseGallery.querySelectorAll('[data-pose]')).find(button => button.dataset.pose === location.hash.slice(1));
    if (card) {
      poseGallery.scrollIntoView({block:'start'});
      inspectPose(card);
    }
  }
  window.addEventListener('hashchange', openLinkedPose);
  openLinkedPose();

  modelControls.addEventListener('change', () => inspectPose(poseGallery.querySelector('[data-pose][aria-pressed=true]')));
  for (const demo of $$('[data-primitive-scene]')) {
    const cover = demo.querySelector('.demo-cover');
    const launch = cover.querySelector('button');
    const message = demo.querySelector('[role=status]');
    const gallery = demo.closest('.primitive-feature, .camera-study-gallery');
    const cards = gallery?.querySelectorAll('[data-primitive]') || [];
    let sequence = 0, current;
    new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) current?.pause(); }).observe(demo);

    async function inspect(card) {
      const ticket = ++sequence;
      if (card) {
        for (const item of cards) item.setAttribute('aria-pressed', String(card === item));
        const imagePreview = gallery.querySelector('#primitive-image');
        if (imagePreview) {
          const showImage = card.hasAttribute('data-image');
          imagePreview.hidden = !showImage;
          demo.hidden = showImage;
          gallery.querySelector('.media-links').hidden = showImage;
          if (showImage) {
            current?.remove();
            current = null;
            return;
          }
        }
        demo.dataset.primitiveScene = card.dataset.primitive;
        demo.dataset.footage = card.dataset.footage;
        demo.dataset.meshRevision = card.dataset.meshRevision || '';
        demo.dataset.frame = card.dataset.frame;
        cover.querySelector('img').src = card.querySelector('img').src;
        const source = gallery.querySelector('.media-links a');
        if (source && card.dataset.original) {
          source.href = card.dataset.original;
          const title = card.querySelector('span').textContent.split(' ·')[0];
          source.querySelector('span').textContent = source.hasAttribute('download') ? 'Download ' + title + ' footage' : title + ' footage · Pexels';
        }
      }
      current?.remove();
      current = null;
      cover.hidden = false;
      launch.disabled = true;
      message.hidden = true;
      const key = 'primitive-' + demo.dataset.primitiveScene;
      try {
        await script(key + '.js?v=' + encodeURIComponent(demo.dataset.meshRevision || 'motion-review-4'));
        if (ticket !== sequence) return;
        const scene = {...window.PerspectraExamples[key]};
        if (gallery?.matches('.primitive-feature')) { delete scene.cloud; scene.show = {...scene.show, cameraCloud:false}; }
        const player = await viewer(scene, url('full/' + demo.dataset.footage + '/source.mp4'),
          cover.querySelector('img').src, demo.querySelector('.comparison-viewer'), {frame:Number(demo.dataset.frame), hidden:true});
        if (ticket !== sequence) { player.remove(); return; }
        current = player;
        player.hidden = false;
        cover.hidden = true;
        pauseOthers(player);
        if (document.activeElement === launch) player.shadowRoot.querySelector('.play').focus({preventScroll:true});
      } catch (error) {
        if (ticket !== sequence) return;
        message.textContent = 'Could not load the scene. ' + error.message;
        message.hidden = false;
      } finally { if (ticket === sequence) launch.disabled = false; }
    }
    launch.addEventListener('click', () => inspect());
    for (const card of cards) card.addEventListener('click', () => inspect(card));
    if (gallery) {
      const selectLinkedClip = () => {
        const card = document.getElementById(location.hash.slice(1));
        if (card?.matches('[data-primitive]') && gallery.contains(card)) inspect(card);
      };
      window.addEventListener('hashchange', selectLinkedClip);
      selectLinkedClip();
    }
  }

  // Same seek-safe loading for the lightweight feature clips.
  const pendingVideos = new WeakMap();
  function attachPreview(v, name) {
    if (pendingVideos.has(v)) return pendingVideos.get(v);
    const promise = (async () => {
      v.removeAttribute('loading');
      let source = url(name);
      if (/^https?:/.test(source)) {
        const response = await fetch(source);
        if (!response.ok) throw new Error('Preview video unavailable');
        source = URL.createObjectURL(await response.blob());
        window.addEventListener('pagehide', () => URL.revokeObjectURL(source), { once: true });
      }
      v.preload = 'metadata'; v.src = source; v.load();
    })().catch(() => { pendingVideos.delete(v); v.src=url(name);v.load(); });
    pendingVideos.set(v,promise);return promise;
  }

  for (const demo of $$('.overlay-demo')) {
    const v = demo.querySelector('video'), canvas = demo.querySelector('canvas'), ctx = canvas.getContext('2d');
    const expand = demo.querySelector('[data-expand]');
    if (document.fullscreenEnabled) {
      expand.hidden = false;
      expand.addEventListener('click', async () => {
        try { if (document.fullscreenElement === demo) await document.exitFullscreen(); else await demo.requestFullscreen(); } catch {}
      });
      document.addEventListener('fullscreenchange', () => expand.setAttribute('aria-label', document.fullscreenElement === demo ? 'Exit expanded preview' : 'Expand preview'));
    }
    let result = true, data = null, ready = false;
    const draw = (mediaTime = v.currentTime) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!result || !data) return;
      const k = Math.min(data.frames.length - 1, Math.max(0, Math.floor(mediaTime * data.fps + 0.001)));
      const row = data.frames[k];
      for (const group of row) {
        ctx.strokeStyle = group.color; ctx.lineWidth = group.width || 2;
        ctx.beginPath();
        for (const line of group.lines) { ctx.moveTo(line[0], line[1]); ctx.lineTo(line[2], line[3]); }
        ctx.stroke();
      }
    };
    const init = async () => {
      if (ready) return; ready = true;
      try { await script(demo.dataset.overlayScript || (demo.dataset.overlay === 'mesh' ? 'mesh-overlay.js' : 'overlays.js?v=acc4583e98')); data = window.PerspectraOverlays[demo.dataset.overlay]; draw(); }
      catch(e) { ready = false; demo.querySelector('.media-caption').textContent = 'Overlay data could not load. Playing the original footage.'; }
    };
    v.addEventListener('play', () => { pauseOthers(v); init(); });
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const tick = (_, meta) => { if (data && result) draw(meta.mediaTime); v.requestVideoFrameCallback(tick); };
      v.requestVideoFrameCallback(tick);
    } else { v.addEventListener('timeupdate', () => draw()); }
    v.addEventListener('seeked', () => draw()); v.addEventListener('loadeddata', () => { init(); });
    demo.querySelectorAll('[data-overlay-mode]').forEach(button => button.addEventListener('click', () => {
      result = button.dataset.overlayMode === 'result';
      demo.querySelectorAll('[data-overlay-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      if (result) init(); draw();
    }));
    const attachMedia = () => {
      attachPreview(v, v.dataset.src.replace(/^assets\//, ''));
    };
    v.addEventListener('pointerdown', attachMedia, { once:true });
    const io = new IntersectionObserver(entries => { for (const entry of entries) {
      if (entry.isIntersecting) attachMedia();
      else v.pause();
    } }, { rootMargin: '150px' }); io.observe(v);
  }
  const pauseOffscreen = new IntersectionObserver(entries => entries.forEach(e => { if (!e.isIntersecting) e.target.querySelector('perspectra-preview')?.pause(); }));
  pauseOffscreen.observe($('#automatic-viewer')); pauseOffscreen.observe($('#manual-viewer')); pauseOffscreen.observe(poseMount);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseOthers(); });

  const slider=$('#fisheye-slider');
  const updateSplit=()=>{slider.closest('.before-after').style.setProperty('--split',slider.value+'%');slider.setAttribute('aria-valuetext',slider.value+'% original image visible');};
  slider.addEventListener('input',updateSplit);updateSplit();
  for(const v of $$('.feature-video')){
    const attach=()=>attachPreview(v,v.dataset.src);
    v.addEventListener('play',()=>pauseOthers(v));
    if (!v.dataset.src) {
      new IntersectionObserver(entries => { if (!entries[0].isIntersecting) v.pause(); }).observe(v);
      continue;
    }
    v.addEventListener('pointerdown',attach,{once:true});
    new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting)attach();else v.pause();}),{rootMargin:'150px'}).observe(v);
  }
  // Optional host integration. Opt in with ?parentOrigin=https://your-store.example.
  const parentOrigin=new URLSearchParams(location.search).get('parentOrigin');
  if (window.parent!==window && parentOrigin && /^https?:\/\//.test(parentOrigin)) {
    let origin;try{origin=new URL(parentOrigin).origin;}catch{}
    if(origin){let last=0;new ResizeObserver(()=>{const height=document.documentElement.scrollHeight;if(height!==last){last=height;parent.postMessage({type:'perspectra:resize',height},origin);}}).observe(document.body);}
  }
})();
