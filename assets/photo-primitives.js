// Best photo solve and blockout.fit output for the selected subjects in rgb.jpeg.
window.showCoffeePrimitives = function (host) {
  const picture = host.querySelector('img'), button = host.querySelector('button');
  const renderer = new THREE.WebGLRenderer({alpha:true, antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label','Photo primitives. Drag or use arrow keys to orbit. Use the button to return to the photo.');
  host.insertBefore(canvas,button);
  const scene = new THREE.Scene();
  // Best photo solve for rgb.jpeg, on a 36 mm sensor. Convert Blender (X,Y,Z)
  // to this viewer's (X,Z,-Y) and OpenCV's down/forward camera to Three.js up/back.
  const camera = new THREE.PerspectiveCamera(21.996277,1,.01,20);
  camera.up.set(0,1,0);
  const photoEye = new THREE.Vector3(0,.491517,2.495358);
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(.921718,.005754,.387818),
    new THREE.Vector3(.072269,.979832,-.186297),
    new THREE.Vector3(-.381068,.199741,.902713)
  );
  const target = new THREE.Vector3(.72,.13,.91);
  function matchPhoto() {
    camera.position.copy(photoEye);
    camera.quaternion.setFromRotationMatrix(basis);
    camera.updateMatrixWorld();
  }
  matchPhoto();

  function add(geometry, center, color) {
    const material = new THREE.MeshBasicMaterial({color,transparent:true,opacity:.12,depthWrite:false});
    const mesh = new THREE.Mesh(geometry,material);
    // Occlude distant outlines where the machine or another solid occupies the pixel.
    const depth = new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({
      colorWrite:false,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1
    }));
    depth.renderOrder = -1;
    mesh.add(depth);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry,25),new THREE.LineBasicMaterial({color}));
    edges.renderOrder = 2;
    mesh.add(edges); mesh.position.copy(center); scene.add(mesh);
    return mesh;
  }
  // Convert each fitted Blender transform into viewer coordinates.
  const worldToView = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  const fits = [
  {
    "name": "machine",
    "kind": "BOX",
    "center": [
      0.8765568,
      -0.4731498,
      0.0491088
    ],
    "size": [
      0.1328731,
      0.4489209,
      0.3647494
    ],
    "rotation": [
      [
        0.9993812,
        -0.0351732,
        0.0
      ],
      [
        0.0351732,
        0.9993812,
        0.0
      ],
      [
        0.0,
        0.0,
        1.0
      ]
    ]
  },
  {
    "name": "milk",
    "kind": "CYLINDER",
    "center": [
      1.3345091,
      -0.1469359,
      -0.0642086
    ],
    "size": [
      0.0938397,
      0.0938397,
      0.2460302
    ],
    "rotation": [
      [
        1.0,
        -0.0,
        0.0
      ],
      [
        0.0,
        1.0,
        0.0
      ],
      [
        0.0,
        0.0,
        1.0
      ]
    ]
  },
  {
    "name": "cup",
    "kind": "CYLINDER",
    "center": [
      0.9150048,
      -0.61775,
      -0.0613815
    ],
    "size": [
      0.0680456,
      0.0680456,
      0.0568965
    ],
    "rotation": [
      [
        1.0,
        -0.0,
        0.0
      ],
      [
        0.0,
        1.0,
        0.0
      ],
      [
        0.0,
        0.0,
        1.0
      ]
    ]
  },
  {
    "name": "counter",
    "kind": "BOX",
    "center": [
      0.7786829,
      -0.5116543,
      -0.1606178
    ],
    "size": [
      1.3274747,
      0.4464886,
      0.0701243
    ],
    "rotation": [
      [
        0.9999713,
        0.0075722,
        0.0
      ],
      [
        -0.0075722,
        0.9999713,
        0.0
      ],
      [
        0.0,
        0.0,
        1.0
      ]
    ]
  },
  {
    "name": "wall",
    "kind": "PLANE",
    "center": [
      1.1649366,
      0.1587149,
      0.1713422
    ],
    "size": [
      1.1376605,
      0.5997537,
      0.0227532
    ],
    "rotation": [
      [
        -0.9948959,
        -0.0760631,
        0.0663061
      ],
      [
        0.0658887,
        0.0079866,
        0.997795
      ],
      [
        -0.0764249,
        0.997071,
        -0.0029341
      ]
    ]
  }
];
  const colors = {machine:0x087c88, milk:0x297c57, cup:0xac6024, counter:0x885029, wall:0x677598};
  for (const fit of fits) {
    const [x,y,z] = fit.size;
    let geometry;
    if (fit.kind === 'CYLINDER') geometry = new THREE.CylinderGeometry(x/2,x/2,z,48).rotateX(Math.PI/2);
    else if (fit.kind === 'BOX') geometry = new THREE.BoxGeometry(x,y,z);
    else geometry = new THREE.PlaneGeometry(x,y);
    const mesh = add(geometry,new THREE.Vector3(...fit.center),colors[fit.name]);
    const [a,b,c] = fit.rotation;
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().set(...a,0,...b,0,...c,0,0,0,0,1));
    mesh.applyMatrix4(worldToView);
    if (fit.name === 'machine') target.copy(mesh.position);
  }
  const angles = new THREE.Spherical().setFromVector3(photoEye.clone().sub(target));
  let matched = true;
  function draw() {
    renderer.setSize(host.clientWidth,host.clientHeight,false);
    if (matched) matchPhoto();
    else {
      camera.clearViewOffset();
      camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(angles));
      camera.lookAt(target);
    }
    renderer.render(scene,camera);
  }
  function orbit(dx,dy) {
    matched = false;
    picture.style.visibility = 'hidden';
    angles.theta -= dx*.008;
    angles.phi = Math.max(.12,Math.min(Math.PI*.85,angles.phi-dy*.008));
    button.textContent = 'Return to photo';
    draw();
  }
  function reset() {
    matched = true;
    angles.setFromVector3(photoEye.clone().sub(target));
    picture.style.visibility = '';
    button.textContent = 'Orbit primitives';
    draw();
  }
  let pointer;
  canvas.onpointerdown = e => {canvas.setPointerCapture(e.pointerId); pointer=[e.clientX,e.clientY]};
  canvas.onpointermove = e => {
    if (!pointer) return;
    orbit(e.clientX-pointer[0],e.clientY-pointer[1]); pointer=[e.clientX,e.clientY];
  };
  canvas.onlostpointercapture = () => {pointer=null};
  canvas.onkeydown = e => {
    const delta = {ArrowLeft:[15,0],ArrowRight:[-15,0],ArrowUp:[0,15],ArrowDown:[0,-15]}[e.key];
    if (delta) {e.preventDefault();orbit(...delta)}
  };
  button.onclick = () => picture.style.visibility === 'hidden' ? reset() : orbit(50,-10);
  new ResizeObserver(draw).observe(host);
  reset();
};
