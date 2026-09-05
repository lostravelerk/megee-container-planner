import * as THREE from 'three';

// World axes: X = front to door, Y = up, Z = near/far width.
// The nominal measured interior occupies [-L/2,L/2] × [0,H] × [-W/2,W/2].
// All solid reference material stays OUTSIDE that space. Corrugation and deck
// thickness illustrate the surface; they are not a certified shell specification.
export function createContainerReference(container) {
  if (![container.l, container.w, container.h].every(n => Number.isFinite(n) && n > 0))
    throw new Error('Reference faces require positive measured interior dimensions');
  const l = container.l / 1000, w = container.w / 1000, h = container.h / 1000;
  const root = new THREE.Group(); root.name = 'container-reference-faces';
  const steel = new THREE.MeshStandardMaterial({ color: '#607689', roughness: .78, metalness: .15, side: THREE.DoubleSide });
  const frontSteel = new THREE.MeshStandardMaterial({ color: '#3b5368', roughness: .78, metalness: .15, side: THREE.DoubleSide });
  const backing = new THREE.MeshStandardMaterial({ color: '#354c60', roughness: .80, metalness: .12 });
  const floorMaterial = new THREE.MeshStandardMaterial({ color: '#9dabb5', roughness: .94, metalness: .02 });
  const addMesh = (group, geometry, material) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true; mesh.castShadow = true; group.add(mesh); return mesh;
  };
  const corrugated = (axis, span) => {
    const ribCount = Math.max(1, Math.ceil(span / .28));
    const points = [], indices = [], recess = .012;
    const profile = [[0,0],[.14,0],[.31,1],[.69,1],[.86,0],[1,0]];
    for (let rib = 0; rib < ribCount; rib++) for (const [fraction, depth] of profile) {
      const along = -span / 2 + (rib + fraction) * span / ribCount;
      const xyz = axis === 'x' ? [-l / 2 - depth * recess, along] : [along, -w / 2 - depth * recess];
      points.push(xyz[0], 0, xyz[1], xyz[0], h, xyz[1]);
    }
    for (let pair = 0; pair < points.length / 6 - 1; pair++) {
      const a = pair * 2;
      indices.push(...(axis === 'x' ? [a,a+1,a+2,a+1,a+3,a+2] : [a,a+2,a+1,a+1,a+2,a+3]));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    return geometry;
  };
  const front = new THREE.Group(); front.name = 'front-wall';
  addMesh(front, corrugated('x', w), frontSteel);
  addMesh(front, new THREE.BoxGeometry(.004, h, w), backing).position.set(-l/2-.014,h/2,0);
  root.add(front);
  const floor = new THREE.Group(); floor.name = 'floor';
  addMesh(floor, new THREE.BoxGeometry(l,.028,w),floorMaterial).position.set(0,-.014,0);
  root.add(floor);
  const far = new THREE.Group(); far.name = 'far-side-wall';
  addMesh(far,corrugated('z',l),steel);
  addMesh(far,new THREE.BoxGeometry(l,h,.004),backing).position.set(0,h/2,-w/2-.014);
  root.add(far);
  return root;
}
