/* Decorative WebGL 1 only; no DOM-to-canvas or experimental canvas-html APIs. */
(() => {
  'use strict';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const vertexSource = `attribute vec2 position;
    varying vec2 uv;
    void main(){ uv = position * .5 + .5; gl_Position = vec4(position,0.,1.); }`;
  // Original procedural light field: two soft pools and a slowly flowing ribbon.
  // This never samples, distorts, or renders the page's text or demo videos.
  const fragmentSource = `precision mediump float;
    varying vec2 uv;
    uniform float time;
    uniform float seed;
    void main(){
      float t = time * .16 + seed;
      float wave = sin(uv.x * 5.5 + t) * .10 + sin(uv.x * 10. - t * .65) * .035;
      float d = abs(uv.y - (.44 + wave));
      float ribbon = exp(-d * 70.);
      float haze = exp(-d * 8.);
      vec2 a = (uv - vec2(.13 + sin(t * .6) * .12,.55)) * vec2(1.,1.35);
      vec2 b = (uv - vec2(.87 + cos(t * .5) * .08,.72)) * vec2(1.,1.2);
      float violet = exp(-dot(a,a) * 8.);
      float cyan = exp(-dot(b,b) * 9.);
      vec3 color = mix(vec3(.49,.24,1.), vec3(.10,.82,.94), smoothstep(.15,.9,uv.x));
      float intensity = .15 * haze + .08 * ribbon + .25 * violet + .21 * cyan;
      intensity *= .55 + .45 * abs(uv.x * 2. - 1.);
      gl_FragColor = vec4(color * intensity, intensity);
    }`;

  for (const [index, field] of [...document.querySelectorAll('[data-ambient]')].entries()) {
    const canvas = field.querySelector('canvas');
    let gl, program, buffer, timeUniform, frame = 0, last = 0, elapsed = 0;
    let visible = false, skipped = false, failed = false, lost = false;
    const stop = () => { cancelAnimationFrame(frame); frame = 0; last = 0; };
    function initialize() {
      gl = canvas.getContext('webgl', {alpha:true, antialias:false, depth:false, stencil:false, powerPreference:'low-power', premultipliedAlpha:true});
      if (!gl) return false;
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); return null; }
        return shader;
      };
      const vertex = compile(gl.VERTEX_SHADER, vertexSource), fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
      if (!vertex || !fragment) { if (vertex) gl.deleteShader(vertex); if (fragment) gl.deleteShader(fragment); return false; }
      program = gl.createProgram();
      if (!program) { gl.deleteShader(vertex); gl.deleteShader(fragment); return false; }
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      gl.deleteShader(vertex); gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); program = null; return false; }
      gl.useProgram(program);
      buffer = gl.createBuffer();
      if (!buffer) { gl.deleteProgram(program); program = null; return false; }
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'position');
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
      timeUniform = gl.getUniformLocation(program,'time');
      gl.uniform1f(gl.getUniformLocation(program,'seed'),index * 2.4);
      resize();
      return true;
    }
    function resize() {
      if (!gl || !program || lost) return;
      // Broad, soft lighting does not need full device resolution. Cap the
      // drawing surface and avoid allocating a large buffer on Retina screens.
      const width = Math.max(1,field.clientWidth), height = Math.max(1,field.clientHeight);
      const scale = Math.min(1, 720 / width, 650 / height);
      canvas.width = Math.max(1,Math.round(width * scale));
      canvas.height = Math.max(1,Math.round(height * scale));
      gl.viewport(0,0,canvas.width,canvas.height);
    }
    function tick(now) {
      frame = requestAnimationFrame(tick);
      // At most 30 rendered frames/sec, independent of the display refresh rate.
      if (last && now - last < 1000 / 30) return;
      elapsed += last ? Math.min((now - last) / 1000,.1) : 0;
      last = now;
      gl.uniform1f(timeUniform,elapsed); gl.drawArrays(gl.TRIANGLES,0,3);
    }
    function update() {
      const run = visible && !skipped && !document.hidden && !reduced.matches && !failed && !lost;
      if (!run) { stop(); field.dataset.state = failed ? 'fallback' : 'paused'; return; }
      if (!program) {
        try { failed = !initialize(); } catch { failed = true; }
        if (failed) { field.dataset.state = 'fallback'; return; }
      }
      field.dataset.state = 'running';
      if (!frame) frame = requestAnimationFrame(tick);
    }
    // Direct listener: this rendering-lifecycle event does not reliably bubble.
    field.addEventListener('contentvisibilityautostatechange', event => { skipped = event.skipped; update(); });
    // Also supplies lazy initialization and an exact-visibility fallback on
    // browsers without content-visibility / its lifecycle event.
    const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; update(); });
    observer.observe(field);
    new ResizeObserver(resize).observe(field);
    reduced.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('pagehide', stop);
    window.addEventListener('pageshow', update);
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault(); lost = true; program = null; buffer = null; stop(); field.dataset.state = 'fallback';
    });
    canvas.addEventListener('webglcontextrestored', () => { lost = false; failed = false; update(); });
  }
})();
