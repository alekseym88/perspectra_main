/* Standard WebGL 1 + Canvas 2D. No DOM capture or experimental canvas APIs.
   Terrain adapts the supplied 30 x 30 dot / four-octave noise reference. Its
   original noise credit: reider's Mars, https://www.shadertoy.com/view/XdsGWH.
   Moving the work to vertices draws 900 points once, instead of testing all
   900 dots for every screen pixel. Banner text stays semantic HTML. */
(() => {
  'use strict';
  const hero = document.querySelector('.hero');
  if (!hero) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const forced = matchMedia('(forced-colors: active)');
  const still = () => reduced.matches || forced.matches;

  function createProgram(canvas, vertex, fragment) {
    const gl = canvas.getContext('webgl', {alpha:true, antialias:false,
      depth:false, stencil:false, premultipliedAlpha:true, powerPreference:'low-power'});
    if (!gl) throw new Error('WebGL unavailable');
    const shaders = [];
    let program;
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Shader allocation failed');
        shaders.push(shader); gl.shaderSource(shader,source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error('Shader compile failed');
      }
      program = gl.createProgram();
      if (!program) throw new Error('Program allocation failed');
      shaders.forEach(shader => gl.attachShader(program,shader)); gl.linkProgram(program);
      if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error('Shader link failed');
      gl.useProgram(program); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
      return {gl,program};
    } catch (error) { if (program) gl.deleteProgram(program); throw error; }
    finally { shaders.forEach(shader => gl.deleteShader(shader)); }
  }

  function upload(gl,program,data,fields) {
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Buffer allocation failed');
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer); gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
    const stride = fields.reduce((sum,[,size]) => sum+size,0)*4;
    let offset = 0;
    for (const [name,size] of fields) {
      const location = gl.getAttribLocation(program,name);
      if (location >= 0) { gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location,size,gl.FLOAT,false,stride,offset); }
      offset += size*4;
    }
    return buffer;
  }

  // One clock per canvas: no work while hidden/offscreen, no catch-up jumps,
  // and a 30fps ceiling even on 120Hz displays. Lifecycle events are direct.
  function lifecycle(element,setup,draw,{onStop=()=>{}}={}) {
    let visible=false,skipped=false,ready=false,failed=false,lost=false;
    let frame=0,last=0,elapsed=0;
    function stop(){cancelAnimationFrame(frame);frame=0;last=0;}
    function tick(now){
      frame=requestAnimationFrame(tick);
      if(last && now-last<1000/30) return;
      const delta=last ? Math.min((now-last)/1000,.1):0;
      last=now;elapsed+=delta;
      try {
        draw(elapsed,delta);
      } catch { failed=true;stop();element.dataset.state='fallback';onStop(); }
    }
    function update(){
      if(still()) { stop();element.dataset.state='static';onStop();return; }
      if(failed||lost){stop();return;}
      if(!visible||skipped||document.hidden){stop();element.dataset.state='paused';return;}
      if(!ready){try{setup();ready=true;}catch{failed=true;element.dataset.state='fallback';onStop();return;}}
      element.dataset.state='running';if(!frame)frame=requestAnimationFrame(tick);
    }
    const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;update();});
    observer.observe(element);
    element.addEventListener('contentvisibilityautostatechange',event=>{skipped=event.skipped;update();});
    document.addEventListener('visibilitychange',update);
    window.addEventListener('pagehide',stop);window.addEventListener('pageshow',update);
    const canvas=element.querySelector('canvas');
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();lost=true;ready=false;stop();element.dataset.state='fallback';onStop();});
    canvas.addEventListener('webglcontextrestored',()=>{lost=false;failed=false;update();});
    reduced.addEventListener('change',update);
    forced.addEventListener('change',update);
  }

  const terrain=hero.querySelector('.hero-terrain');
  const terrainCanvas=terrain.querySelector('canvas');
  let terrainGL,terrainProgram,terrainTime,terrainYaw,terrainDPR;
  let yaw=-.15,targetYaw=-.15;
  const terrainVertex=`
    precision highp float;
    attribute vec2 grid;
    uniform float time, yaw, pixelRatio;
    varying vec4 color;
    const mat2 mr=mat2(.84147,.54030,.54030,-.84147);
    float hash(float n){return fract(sin(n)*43758.5453);}
    float noise(vec2 x){
      vec2 p=floor(x),f=fract(x);f=f*f*(3.-2.*f);float n=p.x+p.y*57.;
      return mix(mix(hash(n),hash(n+1.),f.x),mix(hash(n+57.),hash(n+58.),f.x),f.y);
    }
    float fbm(vec2 p){
      float f=.5*noise(p);p=mr*p*2.02;
      f+=.25*noise(p);p=mr*p*2.33;
      f+=.125*noise(p);p=mr*p*2.01;
      f+=.0625*noise(p);
      return f/.9375;
    }
    void main(){
      // Travel through world space, recycling rows behind the camera. Sample
      // height in world coordinates so hills approach us instead of boiling.
      float travel=time*28.;
      float depth=mod(grid.y*12.-travel,360.);
      float worldDepth=depth+travel;
      vec2 base=vec2((grid.x-14.5)*12.,depth-180.);
      float sa=sin(yaw),ca=cos(yaw);
      float x=ca*base.x+sa*base.y;
      float z=-sa*base.x+ca*base.y+100.;
      float height=fbm(vec2(grid.x*.2,worldDepth*.016))*64.;
      float y=-160.+height;
      float perspective=300./(z+300.);
      gl_Position=vec4(x/300.*perspective*1.9,.64+y/300.*perspective*2.7,0.,1.);
      gl_PointSize=clamp((1.65+perspective*.9)*pixelRatio,1.,8.);
      float fade=clamp(1.-z/640.,.25,1.)*
        smoothstep(0.,25.,depth)*(1.-smoothstep(300.,360.,depth));
      // Match the orange camera-view point cloud (#ffad32) in track-preview.js.
      color=vec4(vec3(255.,173.,50.)/255.,fade*.88);
    }`;
  const pointFragment=`precision mediump float;varying vec4 color;
    void main(){float r=length(gl_PointCoord-.5);float alpha=(1.-smoothstep(.28,.5,r))*color.a;
    gl_FragColor=vec4(color.rgb*alpha,alpha);}`;
  function terrainResize(){
    if(!terrainGL||terrainGL.isContextLost())return;
    const ratio=Math.min(devicePixelRatio||1,1.5);
    terrainCanvas.width=Math.round(terrain.clientWidth*ratio);
    terrainCanvas.height=Math.round(terrain.clientHeight*ratio);
    terrainGL.viewport(0,0,terrainCanvas.width,terrainCanvas.height);
    terrainGL.uniform1f(terrainDPR,ratio);
  }
  lifecycle(terrain,()=>{
    ({gl:terrainGL,program:terrainProgram}=createProgram(terrainCanvas,terrainVertex,pointFragment));
    const grid=[];for(let z=0;z<30;z++)for(let x=0;x<30;x++)grid.push(x,z);
    upload(terrainGL,terrainProgram,new Float32Array(grid),[['grid',2]]);
    terrainTime=terrainGL.getUniformLocation(terrainProgram,'time');
    terrainYaw=terrainGL.getUniformLocation(terrainProgram,'yaw');
    terrainDPR=terrainGL.getUniformLocation(terrainProgram,'pixelRatio');terrainResize();
    terrain.dataset.points='900';
  },(time,delta)=>{
    yaw+=(targetYaw-yaw)*Math.min(1,delta*2);
    terrainGL.clear(terrainGL.COLOR_BUFFER_BIT);terrainGL.uniform1f(terrainTime,time);
    terrainGL.uniform1f(terrainYaw,yaw);terrainGL.drawArrays(terrainGL.POINTS,0,900);
  });
  new ResizeObserver(terrainResize).observe(terrain);
  hero.addEventListener('pointermove',event=>{
    if(event.pointerType!=='mouse')return;
    const rect=hero.getBoundingClientRect();targetYaw=-.15+((event.clientX-rect.left)/rect.width-.5)*.32;
  },{passive:true});
  hero.addEventListener('pointerleave',()=>{targetYaw=-.15;});

  function mountPromo(promo){
  const canvas=promo.querySelector('.promo-particles');
  let gl,program,buffer,count=0,clockUniform,pointerUniform,sizeUniform,ratioUniform;
  let dimensions={width:0,height:0},needsRebuild=false;
  const cursor={x:0,y:0,strength:0,targetX:0,targetY:0,active:0};
  const promoVertex=`precision highp float;
    attribute vec2 target;
    attribute vec4 rgba;
    attribute vec2 detail;
    uniform vec2 resolution;
    uniform float time,pixelRatio;
    uniform vec3 pointer;
    varying vec4 color;
    vec3 gold(float value){
      // Amber, ochre, honey, gold, lemon and cream, with continuous shading.
      float v=clamp(value,0.,.999)*5.;
      vec3 a=vec3(.72,.34,.035),b=vec3(.88,.52,.055);
      if(v>=1.){a=b;b=vec3(1.,.68,.12);}
      if(v>=2.){a=b;b=vec3(1.,.81,.26);}
      if(v>=3.){a=b;b=vec3(1.,.91,.48);}
      if(v>=4.){a=b;b=vec3(1.,.98,.77);}
      return mix(a,b,fract(v));
    }
    vec3 liquid(vec2 uv,float t){
      vec2 q=vec2(uv.x*3.,uv.y);
      float a=q.y*5.+sin(q.x*2.-t*.65)*1.5;
      float b=q.x*2.5-t*.8;
      vec2 flow=vec2(sin(a+t*.65)*6.,sin(b+q.y*2.)*4.5);
      return vec3(flow,sin(a+b)*.15+cos(b)*.04);
    }
    void main(){
      vec2 point=target;
      // Ink and gold follow the SAME smooth field to keep the image registered.
      // Tiny per-dot drift adds fluid texture without dissolving the lettering.
      float ink=1.-step(.5,rgba.r);
      vec2 uv=target/resolution;
      vec3 surface=liquid(uv,time);
      float edge=smoothstep(0.,.07,uv.x)*smoothstep(0.,.07,1.-uv.x)*
        smoothstep(0.,.12,uv.y)*smoothstep(0.,.12,1.-uv.y);
      float sizeScale=clamp(resolution.y/160.,.6,1.25);
      point+=surface.xy*edge*sizeScale;
      float drift=mix(.75,.12,ink)*edge;
      point+=vec2(sin(time*.7+detail.y*6.28),cos(time*.6+detail.y*6.28))*drift;
      vec2 delta=point-pointer.xy;
      float distance=length(delta);
      float radius=clamp(resolution.x*.13,38.,82.);
      float influence=exp(-distance*distance/(radius*radius)) * pointer.z;
      float push=(18.+sin(distance*.1-time*2.)*2.)*influence;
      point+=delta/max(distance,1.)*push;
      gl_Position=vec4(point.x/resolution.x*2.-1.,1.-point.y/resolution.y*2.,0.,1.);
      gl_PointSize=detail.x*pixelRatio;
      vec3 shaded=gold(clamp(rgba.g+surface.z,.12,1.));
      color=vec4(mix(shaded,rgba.rgb,ink),rgba.a);
    }`;

  // Read individual text-line rectangles, then draw glyphs with the same font.
  // This samples only our own short promo copy, not page/video pixels. The real
  // DOM is retained for selection, search, assistive tech and every fallback.
  function textMask(ctx,base){
    const walker=document.createTreeWalker(promo.querySelector('.signal-middle'),NodeFilter.SHOW_TEXT);
    for(let node;node=walker.nextNode();){
      if(!node.textContent.trim()||node.parentElement.closest('svg'))continue;
      const style=getComputedStyle(node.parentElement),lines=[];
      for(let i=0;i<node.length;i++){
        const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);
        const rect=range.getBoundingClientRect();if(!rect.width)continue;
        let line=lines.find(line=>Math.abs(line.y-rect.y)<1);
        if(!line){line={x:rect.x,y:rect.y,height:rect.height,right:rect.right,text:''};lines.push(line);}
        line.text+=node.textContent[i];line.right=rect.right;
      }
      ctx.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      ctx.fillStyle='#21180d';ctx.textBaseline='alphabetic';
      if('letterSpacing' in ctx)ctx.letterSpacing=style.letterSpacing==='normal'?'0px':style.letterSpacing;
      for(const line of lines){
        const text=style.textTransform==='uppercase'?line.text.toUpperCase():line.text;
        const metrics=ctx.measureText(text),ascent=metrics.fontBoundingBoxAscent??parseFloat(style.fontSize)*.8;
        const descent=metrics.fontBoundingBoxDescent??parseFloat(style.fontSize)*.2;
        const baseline=line.y-base.y+(line.height-ascent-descent)/2+ascent;
        ctx.save();ctx.translate(line.x-base.x,baseline);
        ctx.scale((line.right-line.x)/Math.max(1,metrics.width),1);ctx.fillText(text,0,0);ctx.restore();
      }
    }
    const accent=promo.querySelector('.discount-accent'),matrix=accent.getScreenCTM();
    ctx.save();ctx.transform(matrix.a,matrix.b,matrix.c,matrix.d,matrix.e-base.x,matrix.f-base.y);
    ctx.fill(new Path2D(accent.querySelector('path').getAttribute('d')));ctx.restore();
  }

  function buildBanner(){
    const base=promo.getBoundingClientRect(),width=Math.round(base.width),height=Math.round(base.height);
    if(!width||!height)throw new Error('Banner has no area');
    dimensions={width,height};
    const ratio=Math.min(devicePixelRatio||1,1.5);
    canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
    gl.viewport(0,0,canvas.width,canvas.height);gl.uniform2f(sizeUniform,width,height);gl.uniform1f(ratioUniform,ratio);
    // Supersample the short copy so small letters stay readable on Retina and
    // mobile screens. The denser ink particles still move with the same field.
    const mask=document.createElement('canvas');mask.width=width*2;mask.height=height*2;
    const ctx=mask.getContext('2d',{willReadFrequently:true});ctx.scale(2,2);textMask(ctx,base);
    const pixels=ctx.getImageData(0,0,mask.width,mask.height).data,points=[];
    const alphaAt=(x,y)=>pixels[(Math.floor(y*2)*mask.width+Math.floor(x*2))*4+3];
    let seed=429;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    function push(x,y,r,g,b,size){
      points.push(x,y,r,g,b,1,size,random());
    }
    // Coarse, warm dots build the entire card; finer dark dots resolve letters.
    const spacing=2.4,dotSize=2.2;
    for(let y=2;y<height-1;y+=spacing)for(let x=2;x<width-1;x+=spacing){
      if(alphaAt(x,y)>50)continue;
      // Store a continuous gold-palette coordinate in green for the shader.
      const shade=.48+random()*.32+Math.sin(x/width*6.+y/height*2.)*.08;
      push(x+(random()-.5)*.9,y+(random()-.5)*.9,1,shade,.4,dotSize);
    }
    for(let y=0;y<height;y+=.65)for(let x=0;x<width;x+=.65){
      if(alphaAt(x,y)>110)push(x,y,.129,.094,.051,1.5);
    }
    if(buffer)gl.deleteBuffer(buffer);
    buffer=upload(gl,program,new Float32Array(points),[['target',2],['rgba',4],['detail',2]]);
    count=points.length/8;promo.dataset.points=String(count);
  }
  function finishBanner(){
    cursor.active=0;cursor.strength=0;
    promo.classList.remove('is-live');promo.dataset.phase='static';
  }
  function moveCursor(event){
    if(event.pointerType!=='mouse'&&event.pointerType!=='pen')return;
    const rect=promo.getBoundingClientRect();
    cursor.targetX=event.clientX-rect.left;cursor.targetY=event.clientY-rect.top;
    if(!cursor.active&&cursor.strength<.01){cursor.x=cursor.targetX;cursor.y=cursor.targetY;}
    cursor.active=1;
  }
  // Passive pointer input does not capture touches or interfere with scrolling.
  promo.addEventListener('pointermove',moveCursor,{passive:true});
  promo.addEventListener('pointerenter',moveCursor,{passive:true});
  promo.addEventListener('pointerleave',()=>{cursor.active=0;},{passive:true});
  promo.addEventListener('pointercancel',()=>{cursor.active=0;},{passive:true});
  window.addEventListener('blur',()=>{cursor.active=0;});
  async function prepareBanner(){
    // Keep the complete HTML banner visible until its fonts and dot image are ready.
    await document.fonts.ready;
    if(getComputedStyle(promo).display==='none')return;
    lifecycle(promo,()=>{
      ({gl,program}=createProgram(canvas,promoVertex,pointFragment));buffer=null;
      clockUniform=gl.getUniformLocation(program,'time');sizeUniform=gl.getUniformLocation(program,'resolution');
      pointerUniform=gl.getUniformLocation(program,'pointer');
      ratioUniform=gl.getUniformLocation(program,'pixelRatio');buildBanner();
    },(time,delta)=>{
      if(needsRebuild){buildBanner();needsRebuild=false;}
      const follow=1.-Math.exp(-delta*10.);
      cursor.x+=(cursor.targetX-cursor.x)*follow;cursor.y+=(cursor.targetY-cursor.y)*follow;
      cursor.strength+=(cursor.active-cursor.strength)*(1.-Math.exp(-delta*7.));
      gl.clear(gl.COLOR_BUFFER_BIT);gl.uniform1f(clockUniform,time);
      gl.uniform3f(pointerUniform,cursor.x,cursor.y,cursor.strength);gl.drawArrays(gl.POINTS,0,count);
      promo.classList.add('is-live');promo.dataset.phase='floating';
    },{onStop:finishBanner});
    // Rebuild only when dimensions/fonts change, not on cursor movement.
    new ResizeObserver(()=>{
      if(dimensions.width&&(Math.abs(promo.offsetWidth-dimensions.width)>1||Math.abs(promo.offsetHeight-dimensions.height)>1))needsRebuild=true;
    }).observe(promo);
    document.fonts.addEventListener('loadingdone',()=>{if(dimensions.width)needsRebuild=true;});
  }
  prepareBanner().catch(finishBanner);
  }
  hero.querySelectorAll('.launch-promo').forEach(mountPromo);
})();
