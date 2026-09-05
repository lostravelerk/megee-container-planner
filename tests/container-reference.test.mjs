import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {createContainerReference} from '../lib/containerReference.js';
const sizes=[{l:5898,w:2352,h:2393},{l:12032,w:2352,h:2698},{l:8000,w:2400,h:2500}];
test('exactly three solid reference faces: closed front, floor, far wall; never roof, near wall or doors',()=>{
  for(const c of sizes){
    const scene=createContainerReference(c);scene.updateMatrixWorld(true);
    assert.deepEqual(scene.children.map(o=>o.name),['front-wall','floor','far-side-wall']);
    const [front,floor,far]=scene.children.map(o=>new THREE.Box3().setFromObject(o));
    const epsilon=1e-6; // GPU float coordinates only, no input dimension rounding.
    assert.ok(Math.abs(front.max.x+c.l/2000)<epsilon);
    assert.ok(Math.abs(floor.max.y)<epsilon);
    assert.ok(Math.abs(far.max.z+c.w/2000)<epsilon);
    assert.ok(front.min.x < -c.l/2000 && far.min.z < -c.w/2000 && floor.min.y < 0);
    assert.ok(Math.abs(front.max.y-c.h/1000)<epsilon);
    assert.ok(Math.abs(floor.max.x-c.l/2000)<epsilon);
    assert.ok(Math.abs(floor.max.z-c.w/2000)<epsilon);
    scene.traverse(o=>{if(o.isMesh){assert.equal(o.material.transparent,false);assert.equal(o.material.opacity,1);
      const p=o.geometry.getAttribute('position'); for(const v of p.array)assert.ok(Number.isFinite(v));}});
  }
});
test('top, near-side and door cameras look through open faces into the measured space',()=>{
  const c=sizes[0],scene=createContainerReference(c);scene.updateMatrixWorld(true);
  const rays=[
    [new THREE.Vector3(0,10,0),new THREE.Vector3(0,-1,0),'floor',10],
    [new THREE.Vector3(0,1,10),new THREE.Vector3(0,0,-1),'far-side-wall',10+c.w/2000],
    [new THREE.Vector3(10,1,0),new THREE.Vector3(-1,0,0),'front-wall',10+c.l/2000],
  ];
  for(const [origin,direction,name,distance]of rays){
    const hits=new THREE.Raycaster(origin,direction).intersectObject(scene,true);
    assert.ok(hits.length); assert.equal(hits[0].object.parent.name,name);
    assert.ok(hits[0].distance>=distance-1e-6);
  }
});
test('invalid interior dimensions cannot silently create a default-size reference',()=>{
  for(const l of [0,-1,NaN,Infinity])assert.throws(()=>createContainerReference({...sizes[0],l}));
});
test('camera presets remain explicit next to the canvas and preserve view across scene rebuilds',()=>{
  const source=readFileSync(new URL('../app/LoadingScene3D.tsx',import.meta.url),'utf8');
  assert.match(source,/className="scene-camera-toolbar"/);
  for(const label of ['俯视图','侧视图','门视图'])assert.ok(source.includes(label));
  assert.match(source,/data-scene-view=\{view\}/);
  assert.match(source,/let currentView: View = activeViewRef.current/);
  assert.match(source,/if \(!palletOnly\) \{\s*const reference = createContainerReference\(\{ l: container.l, w: container.w, h: container.h \}\)/);
  assert.match(source,/scene.add\(reference\)/);
  assert.match(source,/renderer!\.render\(scene, exportCamera\)/);
});
test('report uses wide stacked longitudinal plates and the same dimensioned scene exports',()=>{
  const css=readFileSync(new URL('../app/globals.css',import.meta.url),'utf8');
  assert.match(css,/grid-template-areas:\s*"perspective perspective"\s*"top door"\s*"side door"/);
  const source=readFileSync(new URL('../app/LoadingScene3D.tsx',import.meta.url),'utf8');
  assert.match(source,/showDimensions/);
  assert.match(source,/3000/);
  assert.match(source,/1800/);
});
