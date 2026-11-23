// One demand-rendered orbit view for all reconstructed subjects.
window.PerspectraScanViewer = class {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({canvas, antialias:true});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x252731);
    this.camera = new THREE.PerspectiveCamera(35, 1, .001, 1000);
    this.camera.up.set(0, 0, 1);
    this.center = new THREE.Vector3();
    this.resize = new ResizeObserver(() => this.draw());
    this.resize.observe(canvas);
    canvas.addEventListener('pointerdown', e => {
      if (!e.isPrimary) return;
      canvas.setPointerCapture(e.pointerId);
      this.drag = [e.clientX, e.clientY];
    });
    canvas.addEventListener('pointermove', e => {
      if (!e.isPrimary || !this.drag) return;
      this.rotate((this.drag[0]-e.clientX)*.008, (e.clientY-this.drag[1])*.008);
      this.drag = [e.clientX,e.clientY];
    });
    canvas.addEventListener('lostpointercapture', () => { this.drag = null; });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoom(Math.exp(Math.sign(e.deltaY)*.12));
    }, {passive:false});
    canvas.addEventListener('keydown', e => {
      const delta = {ArrowLeft:[-.13,0], ArrowRight:[.13,0], ArrowUp:[0,.13], ArrowDown:[0,-.13]}[e.key];
      if (delta) { e.preventDefault(); this.rotate(...delta); }
      if (['+','=','-'].includes(e.key)) { e.preventDefault(); this.zoom(e.key === '-' ? 1.18 : 1/1.18); }
    });
  }
  setModel(data, texture) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.map.dispose();
      this.mesh.material.dispose();
    }
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute('position',new THREE.Float32BufferAttribute(data.position,3));
    indexed.setIndex(data.index);
    indexed.computeVertexNormals();
    const geometry = indexed.toNonIndexed();
    indexed.dispose();
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute(data.uv,2));
    geometry.computeBoundingSphere();
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8,this.renderer.capabilities.getMaxAnisotropy());
    this.mesh = new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide}));
    this.scene.add(this.mesh);
    this.center.copy(geometry.boundingSphere.center);
    this.radius = geometry.boundingSphere.radius;
    this.reset();
  }
  reset() { this.az = .55; this.el = .24; this.factor = 1.08; this.draw(); }
  rotate(az,el) {
    this.az += az; this.el = THREE.MathUtils.clamp(this.el+el,-1.55,1.55); this.draw();
  }
  zoom(multiplier) { this.factor = THREE.MathUtils.clamp(this.factor*multiplier,.38,3); this.draw(); }
  draw() {
    const canvas = this.renderer.domElement, width = canvas.clientWidth, height = canvas.clientHeight;
    if (!this.mesh || !width || !height) return;
    this.renderer.setSize(width,height,false);
    this.camera.aspect = width/height;
    this.camera.updateProjectionMatrix();
    const half = THREE.MathUtils.degToRad(this.camera.fov/2);
    const distance = this.factor*this.radius/Math.sin(Math.min(half,Math.atan(Math.tan(half)*this.camera.aspect)));
    this.camera.position.set(Math.cos(this.az)*Math.cos(this.el),Math.sin(this.az)*Math.cos(this.el),Math.sin(this.el))
      .multiplyScalar(distance).add(this.center);
    this.camera.lookAt(this.center);
    this.renderer.render(this.scene,this.camera);
  }
};
