// The photo and overview share world-space geometry and the exported camera solve.
// SVG keeps the original local photo and distorted lens guides crisp at any size.
(() => {
  const base = 'assets/photo-gallery/';
  const colors = ['#fa6675','#58db91','#70baff'];
  const vec = (x,y,z) => new THREE.Vector3(x,y,z);
  function svgNode(parent, tag, attributes) {
    const node = document.createElementNS('http://www.w3.org/2000/svg',tag);
    for (const [key,value] of Object.entries(attributes)) node.setAttribute(key,value);
    parent.append(node);
    return node;
  }
  function fittedEdges(shape) {
    const [x,y,z] = shape.size;
    const rotation = new THREE.Matrix3().set(...shape.rotation.flat());
    const center = vec(...shape.center);
    const world = point => point.applyMatrix3(rotation).add(center);
    if (shape.kind === 'CYLINDER') {
      const ring = height => Array.from({length:49},(_,i) => {
        const angle = i*Math.PI/24;
        return world(vec(x*Math.cos(angle)/2,y*Math.sin(angle)/2,height));
      });
      const bottom = ring(-z/2), top = ring(z/2);
      return [bottom,ring(-z/4),ring(0),ring(z/4),top,...Array.from({length:16},(_,i)=>[bottom[i*3],top[i*3]])];
    }
    const paths=[];
    if (shape.kind === 'BOX') {
      const face = height => [
        world(vec(-x/2,-y/2,height)), world(vec(x/2,-y/2,height)),
        world(vec(x/2,y/2,height)), world(vec(-x/2,y/2,height))
      ];
      const bottom = face(-z/2), top = face(z/2);
      for (let i=0; i<4; i++) {
        const next = (i+1)%4;
        paths.push([bottom[i],bottom[next]], [top[i],top[next]], [bottom[i],top[i]]);
      }
      return paths;
    }
    for (const t of [-.5,-.25,0,.25,.5]) {
      paths.push([world(vec(t*x,-y/2,0)), world(vec(t*x,y/2,0))],
                 [world(vec(-x/2,t*y,0)), world(vec(x/2,t*y,0))]);
    }
    return paths;
  }

  function solidOverview(canvas, invalidate) {
    const renderer = new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'low-power'});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x38393e);
    const sky = new THREE.HemisphereLight(0xfff8ed,0x68697c,1.6);
    sky.position.set(0,0,1);
    const key = new THREE.DirectionalLight(0xfff4df,2.1);
    key.position.set(-3,-4,6);
    scene.add(sky,key);
    let active, objects, meshes, cameraRig, guideLayer;
    function stroke(group, points, color) {
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      group.add(new THREE.Line(geometry,new THREE.LineBasicMaterial({color})));
    }
    function build(d,axes,span,target) {
      if(objects){
        scene.remove(objects);
        objects.traverse(o=>{
          o.geometry?.dispose();
          for(const m of [].concat(o.material || [])){m.map?.dispose();m.dispose()}
        });
      }
      active=d;
      objects=new THREE.Group();
      scene.add(objects);
      meshes=new THREE.Group();cameraRig=new THREE.Group();guideLayer=new THREE.Group();
      objects.add(meshes,cameraRig);
      cameraRig.add(guideLayer);
      const cell=10**Math.floor(Math.log10(span))/5, extent=80*cell;
      const grid=new THREE.GridHelper(extent,80,0x58585c,0x505055);
      grid.rotation.x=Math.PI/2;
      grid.position.set(Math.round(target.x/cell)*cell,Math.round(target.y/cell)*cell,-.0001);
      objects.add(grid);
      stroke(objects,[vec(-extent,0,0),vec(extent,0,0)],0xa6535a);
      stroke(objects,[vec(0,-extent,0),vec(0,extent,0)],0x547952);
      for(const shape of d.shapes){
        for(const path of fittedEdges(shape))stroke(meshes,path,0xffbe64);
      }
      for(const path of d.worldPaths || [])stroke(meshes,path.map(p=>vec(...p)),d.personHeight?0x64eee8:0xffcc67);
      const z=span*.24, f=d.camera.focal;
      const local=(u,v,dist=z)=>vec((u-.5)*d.width*dist/f,(v*d.height-d.camera.cy)*dist/f,dist).applyMatrix3(axes);
      const corners=[[0,0],[1,0],[1,1],[0,1]].map(([u,v])=>local(u,v));
      stroke(cameraRig,[...corners,corners[0]],0xffab38);
      for(const corner of corners)stroke(cameraRig,[vec(0,0,0),corner],0xffab38);
      stroke(cameraRig,[local(.35,0),local(.5,-.14),local(.65,0)],0xffab38);
      const geometry=new THREE.BufferGeometry().setFromPoints(corners);
      geometry.setIndex([0,1,2,0,2,3]);
      geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,1,1,1,1,0,0,0],2));
      const texture=new THREE.TextureLoader().load(d.cameraTexture,()=>{if(active===d)invalidate()});
      texture.colorSpace=THREE.SRGBColorSpace;
      cameraRig.add(new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:2,polygonOffsetUnits:2})));
      for(const [axis,path] of d.lines)stroke(guideLayer,path.map(([u,v])=>local(u,v)),colors[axis]);
    }
    return (d,axes,span,target,cameraEye,orbit,w,h,guides,subject)=>{
      if(active!==d)build(d,axes,span,target);
      cameraRig.position.copy(cameraEye);
      meshes.visible=subject;guideLayer.visible=guides;
      renderer.setSize(w,h,false);
      renderer.render(scene,orbit);
    };
  }

  function sceneViewer(host) {
    host.innerHTML = '<div class="scene-viewport"><canvas hidden aria-hidden="true"></canvas><span class="photo-view-chip"></span><svg class="scene-stage" role="img" tabindex="0"></svg><div class="scene-preview-pip" hidden><img alt=""><span>CAMERA VIEW</span></div></div><div class="scene-tools" role="group" aria-label="Photo scene controls">'+
      '<div class="photo-view-pair"><button type="button" data-view="camera" aria-label="Camera view" title="Camera view"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M1.5 4.5h8.5v7H1.5zM10.8 7.2l3.7-2.2v6l-3.7-2.2z"/></svg></button><button type="button" data-view="overview" aria-label="Overview" title="Overview"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M8 1.2 14 4.5v7L8 14.8 2 11.5v-7zm0 1.7L4.1 5 8 7.1 11.9 5zM3.5 6.3v4.4l3.8 2.1V8.4zm9 0L8.7 8.4v4.4l3.8-2.1z"/></svg></button></div><button type="button" data-full aria-label="Fullscreen" title="Fullscreen"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M1.5 6V1.5H6V3H3v3zM10 1.5h4.5V6H13V3h-3zM14.5 10v4.5H10V13h3v-3zM6 14.5H1.5V10H3v3h3z"/></svg></button><div class="photo-layer-control"><button type="button" data-all aria-pressed="true" aria-label="Show or hide overlays" title="Show or hide overlays"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M8 3.5C4.4 3.5 1.8 6.2 1 8c.8 1.8 3.4 4.5 7 4.5s6.2-2.7 7-4.5c-.8-1.8-3.4-4.5-7-4.5zm0 7.3A2.8 2.8 0 1 1 8 5.2a2.8 2.8 0 0 1 0 5.6z"/></svg></button><button type="button" data-menu aria-expanded="false" aria-label="Overlay options" title="Overlay options"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3.5 6h9L8 11z"/></svg></button><div class="photo-layer-panel" hidden><strong>Photo overlays</strong><label>Camera guides<input type="checkbox" checked data-guides></label><label><span>Meshes</span><input type="checkbox" checked data-subject></label></div></div><label hidden>Scene scale <input type="range" min="65" max="145" value="100" data-scale><output>100%</output></label></div>';
    const find = selector=>host.querySelector(selector);
    const stage=find('svg'), caption=host.parentElement.querySelector(':scope > .photo-run'), guides=find('[data-guides]'), subject=find('[data-subject]'), scale=find('[data-scale]');
    const canvas=find('canvas'), pip=find('.scene-preview-pip');
    const master=find('[data-all]'), menu=find('[data-menu]'), panel=find('.photo-layer-panel');
    function showMenu(open){
      panel.hidden=!open;
      menu.setAttribute('aria-expanded',String(open));
    }
    menu.onclick=()=>showMenu(panel.hidden);
    document.addEventListener('pointerdown',e=>{if(!panel.hidden && !menu.parentElement.contains(e.target))showMenu(false)});
    host.addEventListener('keydown',e=>{if(e.key==='Escape' && !panel.hidden){showMenu(false);menu.focus()}});
    master.onclick=()=>{master.setAttribute('aria-pressed',String(master.getAttribute('aria-pressed')!=='true'));draw()};
    find('[data-full]').onclick=()=>document.fullscreenElement===host ? document.exitFullscreen() : host.requestFullscreen();
    let renderSolid, fallback=false;
    let data, axes, inverse, eye, target, foot, paths, span, mode='camera', yaw, tilt, zoom;
    const orbit = new THREE.PerspectiveCamera(42,1,.001,10000);
    orbit.up.set(0,0,1);
    function draw() {
      if (!data) return;
      const w=data.width,h=data.height,f=data.camera.focal,cy=data.camera.cy;
      const cameraEye=foot ? eye.clone().sub(foot).multiplyScalar(scale.value/100).add(foot) : eye;
      const overview=mode==='overview', W=overview ? Math.max(1,stage.clientWidth) : w,H=overview ? Math.max(1,stage.clientHeight) : h;
      stage.dataset.mode=mode;
      find('.photo-view-chip').textContent=overview?'3D overview':'Camera view';
      if(overview && !renderSolid && !fallback){
        try {renderSolid=solidOverview(canvas,draw)} catch {fallback=true}
      }
      const overlays=master.getAttribute('aria-pressed')==='true';
      const solid=overview && !!renderSolid;
      canvas.hidden=!solid;pip.hidden=!overview;
      stage.classList.toggle('gl-active',solid);
      stage.setAttribute('viewBox','0 0 '+W+' '+H);
      stage.setAttribute('aria-label',data.name+' · '+(overview?'3D overview. Drag or use arrow keys to orbit. Use plus or minus to zoom.':'Matched camera view.'));
      for(const button of host.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed',String(button.dataset.view===mode));
      const content=document.createDocumentFragment();
      const unit=overview ? 1 : Math.min(w,h)/440;
      function line(points,color,weight=1.5) {
        if(points.some(p=>!p)) return;
        svgNode(content,'polyline',{points:points.map(p=>p.join(',')).join(' '),fill:'none',stroke:color,'stroke-width':weight*unit});
      }
      function label(at,text) {
        if(at) svgNode(content,'text',{x:at[0]+5*unit,y:at[1]-4*unit,fill:'white',stroke:'#202533','stroke-width':2.5*unit,'paint-order':'stroke','font-size':12*unit}).textContent=text;
      }
      const project=point=>{
        if(overview){
          const v=point.clone().project(orbit);
          return Math.abs(v.z)>1 ? null : [(v.x+1)*W/2,(1-v.y)*H/2];
        }
        const v=point.clone().sub(cameraEye).applyMatrix3(inverse);
        if(v.z<=0)return null;
        const x=f*v.x/v.z,y=cy-h/2+f*v.y/v.z;
        const {k1,kf}=data.camera;
        const distortion=k1 && kf ? 2/(1+Math.sqrt(Math.max(0,1-4*k1*(x*x+y*y)/(kf*kf)))) : 1;
        return [w/2+x*distortion,h/2+y*distortion];
      };
      const plane=(u,v,z)=>vec((u-.5)*w*z/f,(v*h-cy)*z/f,z).applyMatrix3(axes).add(cameraEye);
      const depth=span*.38;
      if(overview){
        orbit.aspect=W/H;
        const radius=span*zoom/Math.min(1,orbit.aspect);
        orbit.position.copy(target).add(vec(Math.cos(yaw)*Math.cos(tilt),Math.sin(yaw)*Math.cos(tilt),Math.sin(tilt)).multiplyScalar(radius));
        orbit.lookAt(target);orbit.updateProjectionMatrix();orbit.updateMatrixWorld();
        if(solid){
          renderSolid(data,axes,span,target,cameraEye,orbit,W,H,overlays && guides.checked,overlays && subject.checked);
          if(foot && overlays && subject.checked)label(project(foot.clone().add(vec(0,0,1.7))),'1.70 m');
          stage.replaceChildren(content);
          return;
        }
        const cell=10**Math.floor(Math.log10(span))/2;
        const gx=Math.round(target.x/cell)*cell,gy=Math.round(target.y/cell)*cell;
        for(let i=-10;i<=10;i++){
          line([vec(gx+i*cell,gy-10*cell,0),vec(gx+i*cell,gy+10*cell,0)].map(project),'#444957',.8);
          line([vec(gx-10*cell,gy+i*cell,0),vec(gx+10*cell,gy+i*cell,0)].map(project),'#444957',.8);
        }
        const corners=[[0,0],[1,0],[1,1],[0,1]].map(([u,v])=>plane(u,v,depth));
        line([...corners,corners[0]].map(project),'#88c9ff');
        for(const corner of corners)line([cameraEye,corner].map(project),'#88c9ff');
      }else{
        svgNode(content,'image',{href:data.id==='coffee'?'assets/rgb.jpeg':base+data.id+'.webp',width:w,height:h});
      }
      const guidePoint=([u,v])=>overview?project(plane(u,v,depth)):[u*w,v*h];
      if(overlays && guides.checked){
        for(const [axis,points] of data.lines)line(points.map(guidePoint),colors[axis],overview?.85:1.3);
      }
      if(overlays && subject.checked){
        if(!overview && !data.shapes.length && data.paths.length && !foot){
          for(const path of data.paths)line(path.map(([u,v])=>[u*w,v*h]),'#ffbf49',1.7);
        }else{
          for(const path of paths)line(path.map(project),foot?'#64eee8':'#ffcb64',1.8);
        }
        if(foot)label(project(foot.clone().add(vec(0,0,1.7))),'1.70 m');
      }
      stage.replaceChildren(content);
    }
    function setPhoto(d) {
      data=d;
      pip.querySelector('img').src=d.cameraTexture;
      axes=new THREE.Matrix3().set(...d.camera.rotation.flat());inverse=axes.clone().transpose();eye=vec(...d.camera.position);
      paths=[...d.shapes.flatMap(fittedEdges),...(d.worldPaths || []).map(path=>path.map(p=>vec(...p)))];
      foot=null;
      if(d.personHeight){
        const bounds=new THREE.Box3().setFromPoints(paths[0]);
        foot=bounds.getCenter(vec());foot.z=bounds.min.z;
      }
      const bounds=new THREE.Box3().setFromPoints(paths.flat()).expandByPoint(eye);
      if(!paths.length)bounds.expandByPoint(eye.clone().add(vec(0,0,3).applyMatrix3(axes)));
      target=bounds.getCenter(vec());span=Math.max(.1,bounds.getSize(vec()).length());
      yaw=Math.atan2(eye.y-target.y,eye.x-target.x)+1.03;tilt=.42;zoom=1.5;
      scale.value=100;find('output').textContent='100%';scale.parentElement.hidden=!foot;
      subject.parentElement.hidden=!paths.length;
      subject.previousElementSibling.textContent=foot?'Scale figure':d.worldPaths?.length?'Bones':'Meshes';
      if (caption) {
        const [modeValue, timeValue, complexityValue] = caption.querySelectorAll('dd');
        complexityValue.textContent = d.complexity;
        modeValue.textContent = d.mode;
        timeValue.textContent = '≈ ' + d.processingSeconds + ' s';
      }
      draw();
    }
    for(const button of host.querySelectorAll('[data-view]'))button.onclick=()=>{mode=button.dataset.view;draw()};
    host.addEventListener('input',()=>{find('output').textContent=scale.value+'%';draw()});
    let drag;
    stage.onpointerdown=e=>{if(mode==='overview'){stage.setPointerCapture(e.pointerId);drag=[e.clientX,e.clientY]}};
    function rotate(dx,dy){yaw-=dx*.009;tilt=Math.max(-1.35,Math.min(1.35,tilt+dy*.009));draw()}
    stage.onpointermove=e=>{if(drag){const dx=e.clientX-drag[0],dy=e.clientY-drag[1];
      if(e.shiftKey || e.buttons===2){
        const factor=span*zoom/stage.clientHeight;
        target.addScaledVector(vec().setFromMatrixColumn(orbit.matrixWorld,0),-dx*factor);
        target.addScaledVector(vec().setFromMatrixColumn(orbit.matrixWorld,1),dy*factor);
        draw();
      }else rotate(dx,dy);
      drag=[e.clientX,e.clientY]}};
    stage.oncontextmenu=e=>{if(mode==='overview')e.preventDefault()};
    stage.onlostpointercapture=()=>{drag=null};
    function magnify(amount){zoom=Math.max(.25,Math.min(8,zoom*Math.exp(amount)));draw()}
    stage.addEventListener('wheel',e=>{if(mode==='overview'){e.preventDefault();magnify(Math.sign(e.deltaY)*.1)}},{passive:false});
    stage.onkeydown=e=>{
      if(mode!=='overview')return;
      const delta={ArrowLeft:[-12,0],ArrowRight:[12,0],ArrowUp:[0,12],ArrowDown:[0,-12]}[e.key];
      if(delta){e.preventDefault();rotate(...delta)}
      if(['+','=','-'].includes(e.key)){e.preventDefault();magnify(e.key==='-'?.12:-.12)}
    };
    new ResizeObserver(draw).observe(stage);
    return setPhoto;
  }
  const gallery=document.querySelector('#photo-results'), picks=gallery.querySelector('.photo-picks');
  const show=sceneViewer(gallery.querySelector('.photo-scene'));
  for(const d of window.PerspectraPhotoResults){
    if(d.id==='portrait-pose'){
      const portrait=document.querySelector('#portrait-pose-scene');
      const showPortrait=sceneViewer(portrait);
      portrait.querySelector('[data-guides]').checked=false;
      showPortrait(d);
    }
    if(d.id==='coffee'){sceneViewer(document.querySelector('#coffee-scene'))(d);continue}
    const button=document.createElement('button'),image=document.createElement('img');
    button.type='button';image.alt='';image.loading='lazy';
    image.style.setProperty('--thumbnail-ratio', d.width + '/' + d.height);
    image.src=base+d.id+'-thumb.webp';
    const caption=document.createElement('span');
    caption.textContent=d.name;
    button.append(image,caption);
    image.width = d.width;
    image.height = d.height;
    picks.append(button);button.setAttribute('aria-pressed','false');
    button.onclick=()=>{
      for(const item of picks.querySelectorAll('button'))item.setAttribute('aria-pressed',String(item===button));
      show(d);
    };
  }
  picks.querySelector('button').click();
})();
