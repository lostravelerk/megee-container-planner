"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { expandCargo } from "../lib/cargoGeometry.js";
import { createContainerReference } from "../lib/containerReference.js";
import type { CargoUnit } from "../lib/cargoGeometry.js";
import type { ContainerPlan } from "../lib/mixedPacking";
import type { Dimensions, Language } from "./plannerTypes";

export type LoadingSceneSnapshots = { perspective: string; top: string; side: string; door: string };
type View = keyof LoadingSceneSnapshots;
type SceneProps = {
  plan: Pick<ContainerPlan, "positions" | "blocks">;
  container: Dimensions;
  sideClearance: number;
  doorClearance: number;
  topClearance?: number;
  doorWidth?: number;
  doorHeight?: number;
  language: Language;
  visiblePositionCount?: number;
  eager?: boolean;
  snapshotId?: string;
  onSnapshots?: (snapshots: LoadingSceneSnapshots) => void;
  palletOnly?: boolean;
};
const SCENE_COLORS = ["#356fa2", "#587d72", "#77617a", "#647a8f", "#9b805d", "#596679"];
type Batch = { mesh: THREE.InstancedMesh; steps: number[] };
type Runtime = { select: (view: View) => void; reveal: (count: number) => void; interact: (enabled: boolean) => void; zoom: (factor: number) => void };

// Official compact circular MEGEE mark, shared proportions with the report.
// Printed onto the carton material, not a floating label or decorative image.
function drawMegee(context: CanvasRenderingContext2D, x: number, y: number) {
  context.save();
  context.translate(x, y);
  context.strokeStyle = "#243846";
  context.lineWidth = 3;
  context.beginPath(); context.arc(28, 28, 25, 0, Math.PI * 2); context.stroke();
  context.beginPath(); context.moveTo(10, 34); context.lineTo(20, 18);
  context.lineTo(28, 33); context.lineTo(37, 18); context.lineTo(46, 34); context.stroke();
  context.fillStyle = "#243846";
  context.font = "700 25px Arial, sans-serif"; context.fillText("MEGEE", 66, 24);
  context.font = "600 15px Arial, sans-serif"; context.fillText("COSPACK", 67, 46);
  context.restore();
}

function cartonMaterials(color: string, code: string, ea: number, textures: THREE.Texture[], partial = false) {
  const make = (top: boolean) => {
    const canvas = document.createElement("canvas");
    canvas.width = 768; canvas.height = 512;
    const c = canvas.getContext("2d")!;
    // Muted SKU identification tint; identical geometry and printed quantities.
    c.fillStyle = new THREE.Color(color).lerp(new THREE.Color("#f7f4ed"), .30).getStyle();
    c.fillRect(0, 0, 768, 512);
    // Deterministic fine kraft grain. No texture download or per-carton bitmap.
    let seed = 831;
    for (let n = 0; n < 8500; n++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const x = seed % 768;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      c.fillStyle = n % 2 ? "rgba(96,69,36,.08)" : "rgba(255,253,238,.16)";
      c.fillRect(x, seed % 512, 1 + n % 3, 1);
    }
    c.strokeStyle = "rgba(94,74,47,.4)"; c.lineWidth = 3;
    c.strokeRect(2, 2, 764, 508);
    if (top) {
      c.fillStyle = "rgba(190,160,116,.54)"; c.fillRect(345, 0, 78, 512);
      c.strokeStyle = "rgba(101,78,49,.40)"; c.lineWidth = 2;
      c.beginPath(); c.moveTo(383, 0); c.lineTo(383, 512); c.stroke();
      c.fillStyle = color; c.fillRect(28, 30, 130, 12);
      drawMegee(c, 35, 65);
      c.font = "700 32px Arial"; c.fillStyle = "#2b3f4b"; c.fillText(code, 35, 177, 290);
    } else {
      c.fillStyle = new THREE.Color(color).lerp(new THREE.Color("#ffffff"), .62).getStyle();
      c.fillRect(54, 57, 660, 398);
      c.fillStyle = color; c.fillRect(54, 57, 660, 14);
      drawMegee(c, 83, 91);
      c.fillStyle = "#293b48"; c.font = "700 64px Arial, sans-serif";
      c.fillText(code || "SKU", 86, 247, 596);
      c.font = "400 32px Arial, sans-serif";
      c.fillText(ea.toLocaleString() + (partial ? " EA / PARTIAL" : " EA / BOX"), 86, 306, 590);
      c.font = "600 22px Arial, sans-serif"; c.fillText("THIS SIDE UP   ↑ ↑", 86, 397);
      c.font = "500 20px Arial"; c.fillText("MEGEE COSPACK", 490, 397, 185);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
    textures.push(texture);
    return new THREE.MeshStandardMaterial({ map: texture, roughness: .9, metalness: 0 });
  };
  const side = make(false), top = make(true);
  return [side, side, top, top, side, side];
}

export default function LoadingScene3D({
  plan, container, sideClearance, doorClearance, topClearance = 0,
  doorWidth, doorHeight, language, visiblePositionCount, eager = false,
  snapshotId = "", onSnapshots, palletOnly = false,
}: SceneProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const onSnapshotsRef = useRef(onSnapshots);
  const visibleRef = useRef(visiblePositionCount);
  const [mounted, setMounted] = useState(eager);
  const [sceneError, setSceneError] = useState("");
  const [activeView, setActiveView] = useState<View>("perspective");
  const activeViewRef = useRef<View>("perspective");
  const [interaction, setInteraction] = useState(false);
  const interactionRef = useRef(false);
  interactionRef.current = interaction;
  const geometry = useMemo(() => expandCargo(plan), [plan]);
  onSnapshotsRef.current = onSnapshots; visibleRef.current = visiblePositionCount;
  const en = language === "en";
  const shown = Math.min(geometry.positions.length, visiblePositionCount ?? geometry.positions.length);
  const effectiveLength = container.l - doorClearance;
  const selectView = (view: View) => {
    activeViewRef.current = view;
    setActiveView(view);
    runtimeRef.current?.select(view);
  };

  useEffect(() => {
    if (eager) { queueMicrotask(() => setMounted(true)); return; }
    const element = sectionRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { setMounted(true); observer.disconnect(); }
    }, { rootMargin: "480px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [eager]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mounted || !geometry.cartons.length) return;
    let disposed = false, raf = 0, timer = 0, dirty = true, inView = true;
    const materials = new Set<THREE.Material>();
    const textures: THREE.Texture[] = [];
    const geometries = new Set<THREE.BufferGeometry>();
    let renderer: THREE.WebGLRenderer | undefined, controls: OrbitControls | undefined;
    let resizeObserver: ResizeObserver | undefined, observer: IntersectionObserver | undefined;
    const batches: Batch[] = [];
    const dispose = () => {
      disposed = true; cancelAnimationFrame(raf); clearTimeout(timer);
      resizeObserver?.disconnect(); observer?.disconnect(); controls?.dispose();
      batches.forEach(b => b.mesh.dispose());
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
      textures.forEach(t => t.dispose()); renderer?.dispose(); runtimeRef.current = null;
    };
    try {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#f4f5f6");
      // Three measured-interior reference surfaces, never a closed shell.
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = .86;
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.shadowMap.autoUpdate = false;
      const box = new RoundedBoxGeometry(1, 1, 1, 1, .008);
      const flatBox = new THREE.BoxGeometry(1, 1, 1);
      geometries.add(box); geometries.add(flatBox);
      const byId = new Map(plan.blocks.map((b, i) => [b.item.id, { ...b, color: SCENE_COLORS[i % SCENE_COLORS.length] }]));
      const bounds = new THREE.Box3();
      [...geometry.cartons, ...geometry.pallets].forEach(u => {
        bounds.expandByPoint(new THREE.Vector3(u.x, u.z, u.y).multiplyScalar(.001));
        bounds.expandByPoint(new THREE.Vector3(u.x + u.l, u.z + u.h, u.y + u.w).multiplyScalar(.001));
      });
      if (!palletOnly) bounds.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(container.l, container.h, container.w).multiplyScalar(.001));
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const translate = center.clone().negate(); translate.y = 0;
      if (!palletOnly) translate.z += sideClearance / 1000;
      const target = new THREE.Vector3(0, center.y, 0);
      const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion();
      const makeBatch = (units: CargoUnit[], mats: THREE.Material[], primitive = box) => {
        if (!units.length) return;
        mats.forEach(m => materials.add(m));
        const mesh = new THREE.InstancedMesh(primitive, mats.length === 1 ? mats[0] : mats, units.length);
        units.forEach((u, i) => {
          matrix.compose(new THREE.Vector3((u.x + u.l / 2) / 1000 + translate.x,
            (u.z + u.h / 2) / 1000, (u.y + u.w / 2) / 1000 + translate.z),
          quaternion, new THREE.Vector3(u.l, u.h, u.w).multiplyScalar(.001));
          mesh.setMatrixAt(i, matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere();
        scene.add(mesh); batches.push({ mesh, steps: units.map(u => u.positionIndex) });
      };
      byId.forEach((block, id) => {
        makeBatch(geometry.cartons.filter(u => u.skuId === id && !u.tailEa),
          cartonMaterials(block.color, block.item.code || block.item.name || "SKU", block.item.eaPerBox, textures));
        geometry.cartons.filter(u => u.skuId === id && u.tailEa).forEach(u => makeBatch([u],
          cartonMaterials("#b7312e", block.item.code || block.item.name || "SKU", u.tailEa!, textures, true)));
      });
      const plastic = new THREE.MeshStandardMaterial({ color: "#536673", roughness: .62, metalness: .02 });
      // A plastic deck with integral beams and nine feet. The outer dimensions
      // are exact; internal mould details are illustrative, not a pallet spec.
      const addPlasticPallet = (u: CargoUnit) => {
        const pieces: CargoUnit[] = [];
        const deck = u.h * .22, sole = u.h * .15, foot = u.h - deck - sole;
        for (let i = 0; i < 7; i++) pieces.push({ ...u, y: u.y + i * u.w / 7,
          z: u.z + u.h - deck, w: u.w / 7 * .79, h: deck });
        for (let i = 0; i < 3; i++) {
          const y = u.y + i * u.w * .42;
          pieces.push({ ...u, y, w: u.w * .16, h: sole });
          for (let j = 0; j < 3; j++) pieces.push({ ...u, x: u.x + j * u.l * .42,
            y, z: u.z + sole, l: u.l * .16, w: u.w * .16, h: foot });
        }
        return pieces;
      };
      makeBatch(geometry.pallets.flatMap(addPlasticPallet), [plastic], flatBox);
      makeBatch(geometry.separators, [new THREE.MeshStandardMaterial({ color: "#aa906d", roughness: 1 })], flatBox);
      const tape = new THREE.MeshStandardMaterial({ color: "#bc302d", roughness: .62 });
      makeBatch(geometry.cartons.filter(u => u.tailEa).flatMap(u => [
        { ...u, x: u.x + u.l * .43, z: u.z + u.h, l: u.l * .14, h: 1 },
        { ...u, y: u.y + u.w * .43, z: u.z + u.h, w: u.w * .14, h: 1 },
        { ...u, x: u.x + u.l, y: u.y + u.w * .43, l: 1, w: u.w * .14 },
      ]), [tape], flatBox);
      const groundGeometry = new THREE.PlaneGeometry(Math.max(30, size.x * 4), 30);
      geometries.add(groundGeometry);
      const groundMaterial = new THREE.ShadowMaterial({ color: "#263443", opacity: .16 });
      materials.add(groundMaterial);
      const ground = new THREE.Mesh(groundGeometry, groundMaterial);
      ground.rotation.x = -Math.PI / 2; ground.position.y = -.006; ground.receiveShadow = true;
      scene.add(ground);
      const dimensionGroups: { group: THREE.Group; axis: "l" | "w" | "h" }[] = [];
      if (!palletOnly) {
        const reference = createContainerReference({ l: container.l, w: container.w, h: container.h });
        reference.traverse(object => {
          if (object instanceof THREE.Mesh) {
            geometries.add(object.geometry);
            (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => materials.add(m));
          }
        });
        scene.add(reference);
        const lines = (points: number[][], color: string) => {
          const geometry = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(...p)));
          const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: .7 });
          geometries.add(geometry); materials.add(material); scene.add(new THREE.Line(geometry, material));
        };
        const x0 = -size.x / 2, x1 = size.x / 2, z0 = -size.z / 2, z1 = size.z / 2;
        lines([[x0,0,z0],[x1,0,z0],[x1,0,z1],[x0,0,z1],[x0,0,z0]], "#8296a3");
        const end = x1 - doorClearance / 1000, inset = sideClearance / 1000, height = (container.h - topClearance) / 1000;
        lines([[x0,.003,z0+inset],[end,.003,z0+inset],[end,.003,z1-inset],[x0,.003,z1-inset],[x0,.003,z0+inset]], "#418ac1");
        // Far-side height gauge and the actual reference door aperture make
        // unused height and entry clearance visible without obscuring cargo.
        lines([[x0,0,z0],[x0,height,z0],[end,height,z0]], "#6a9dbc");
        const openingW = (doorWidth ?? container.doorW ?? container.w) / 1000;
        const openingH = (doorHeight ?? container.doorH ?? container.h) / 1000;
        lines([[x1,0,-openingW/2],[x1,openingH,-openingW/2],[x1,openingH,openingW/2],[x1,0,openingW/2]], "#b58644");
        // Dimension lines terminate at the same effective bounds used by the
        // solver. Labels are scene objects, so all report plates retain them.
        const dimension = (axis: "l" | "w" | "h", a: number[], b: number[], at: number[], value: number) => {
          const group = new THREE.Group(); group.name = `effective-dimension-${axis}`;
          const p = new THREE.Vector3(...a), q = new THREE.Vector3(...b);
          const tick = axis === "h" ? new THREE.Vector3(0,0,.07) : new THREE.Vector3(0,.07,.07);
          const lineGeometry = new THREE.BufferGeometry().setFromPoints([p,q,p.clone().sub(tick),p.clone().add(tick),q.clone().sub(tick),q.clone().add(tick)]);
          const lineMaterial = new THREE.LineBasicMaterial({ color: "#1b6491", depthTest: false });
          geometries.add(lineGeometry); materials.add(lineMaterial); group.add(new THREE.LineSegments(lineGeometry,lineMaterial));
          const label = document.createElement("canvas"); label.width=1024; label.height=128;
          const c=label.getContext("2d")!;
          c.fillStyle="#f8fbfd"; c.fillRect(0,0,1024,128);
          c.fillStyle="#183e5d"; c.font="600 64px Arial, sans-serif"; c.textAlign="center"; c.textBaseline="middle";
          c.fillText(`${axis.toUpperCase()}  ${value.toLocaleString("en-US",{maximumFractionDigits:2})} mm`,512,66,960);
          const texture=new THREE.CanvasTexture(label); texture.colorSpace=THREE.SRGBColorSpace; textures.push(texture);
          const material=new THREE.SpriteMaterial({map:texture,depthTest:false,toneMapped:false}); materials.add(material);
          const sprite=new THREE.Sprite(material); sprite.position.set(...at as [number,number,number]);
          const factor=Math.max(.8,Math.min(1.5,size.x/8)); sprite.scale.set(1.6*factor,.20*factor,1); sprite.renderOrder=20;
          group.add(sprite); scene.add(group); dimensionGroups.push({group,axis});
        };
        dimension("l",[x0,-.17,z1+.28],[end,-.17,z1+.28],[(x0+end)/2,-.32,z1+.35],container.l-doorClearance);
        dimension("w",[x1+.23,-.17,z0+inset],[x1+.23,-.17,z1-inset],[x1+.35,-.34,0],container.w-sideClearance*2);
        dimension("h",[x1+.23,0,z1+.30],[x1+.23,height,z1+.30],[x1+.52,height/2,z1+.52],container.h-topClearance);
      }
      const showDimensions = (view: View) => dimensionGroups.forEach(({group,axis}) => {
        group.visible = view === "perspective" || (view === "top" ? axis !== "h" : view === "side" ? axis !== "w" : axis !== "l");
      });
      scene.add(new THREE.HemisphereLight("#fffdfa", "#b7bcc1", 1.5));
      const key = new THREE.DirectionalLight("#fff8ed", 2.2);
      key.position.set(-size.x * .15, 16, 2); key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.camera.left = -Math.max(4, size.x);
      key.shadow.camera.right = Math.max(4, size.x);
      key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
      key.shadow.normalBias = .012; key.shadow.bias = -.00005;
      scene.add(key);
      const fill = new THREE.DirectionalLight("#e4edff", .9);
      fill.position.set(3, 4, -5); scene.add(fill);

      // Orthographic interactive camera: the standard views match PDF plates
      // without perspective distortion. OrbitControls still permits rotation.
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 100);
      controls = new OrbitControls(camera, canvas);
      controls.enableDamping = false;
      controls.enabled = interactionRef.current;
      controls.minZoom = .35; controls.maxZoom = 7;
      controls.minPolarAngle = 0; controls.maxPolarAngle = Math.PI * .92;
      controls.enablePan = true; controls.zoomToCursor = true;
      let currentView: View = activeViewRef.current, adjusted = false;
      const offsets: Record<View, THREE.Vector3> = {
        perspective: new THREE.Vector3(1.05, .8, 1.65),
        top: new THREE.Vector3(0, 1, 0),
        side: new THREE.Vector3(0, 0, 1),
        door: new THREE.Vector3(1, 0, 0),
      };
      const pose = (cam: THREE.OrthographicCamera, view: View, aspect: number) => {
        cam.up.set(0, 1, 0); if (view === "top") cam.up.set(0, 0, -1);
        cam.position.copy(target).add(offsets[view].clone().normalize().multiplyScalar(35));
        cam.lookAt(target); cam.updateMatrixWorld();
        // Fit every physical cargo corner, not an invented container frame.
        const projected = new THREE.Box3();
        const pad = palletOnly ? .05 : .8;
        for (const x of [-size.x / 2-pad, size.x / 2+pad]) for (const y of [-pad/2, size.y+pad/2])
          for (const z of [-size.z / 2-pad, size.z / 2+pad])
            projected.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(cam.matrixWorldInverse));
        const spans = projected.getSize(new THREE.Vector3());
        const halfH = Math.max(spans.y, spans.x / aspect) * .57;
        cam.left = -halfH * aspect; cam.right = halfH * aspect;
        cam.top = halfH; cam.bottom = -halfH;
        cam.zoom = 1; cam.updateProjectionMatrix();
      };
      const select = (view: View) => {
        currentView = view; activeViewRef.current = view; adjusted = false;
        ground.visible = view === "perspective";
        showDimensions(view);
        controls!.enableRotate = view === "perspective";
        const dimensions = renderer!.getSize(new THREE.Vector2());
        pose(camera, view, dimensions.x / dimensions.y);
        controls!.target.copy(target); controls!.update();
        dirty = true; setActiveView(view);
      };
      const reveal = (count: number) => {
        batches.forEach(b => { b.mesh.count = b.steps.filter(step => step < count).length; });
        renderer!.shadowMap.needsUpdate = true; dirty = true;
      };
      controls.addEventListener("start", () => { adjusted = true; });
      controls.addEventListener("change", () => { dirty = true; });
      const resize = () => {
        if (disposed || !canvas.parentElement) return;
        const rect = canvas.parentElement.getBoundingClientRect();
        renderer!.setSize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)), false);
        if (!adjusted) select(currentView);
        else { const aspect = rect.width / rect.height; camera.left = -camera.top * aspect; camera.right = camera.top * aspect; camera.updateProjectionMatrix(); }
        dirty = true;
      };
      resizeObserver = new ResizeObserver(resize); resizeObserver.observe(canvas.parentElement!); resize();
      observer = new IntersectionObserver(([entry]) => { inView = !!entry?.isIntersecting; if (inView) dirty = true; });
      observer.observe(canvas);
      runtimeRef.current = { select, reveal, interact: enabled => { controls!.enabled = enabled; },
        zoom: factor => { camera.zoom = Math.max(.35, Math.min(7, camera.zoom * factor)); camera.updateProjectionMatrix(); adjusted = true; dirty = true; } };
      reveal(visibleRef.current ?? geometry.positions.length);
      const animate = () => {
        if (disposed) return;
        raf = requestAnimationFrame(animate);
        if (!inView || document.hidden) return;
        controls!.update();
        if (dirty) { renderer!.render(scene, camera); dirty = false; }
      };
      animate();
      timer = window.setTimeout(() => {
        if (disposed || !onSnapshotsRef.current) return;
        const previousSize = renderer!.getSize(new THREE.Vector2());
        const ratio = renderer!.getPixelRatio();
        reveal(geometry.positions.length);
        renderer!.setPixelRatio(1);
        const snapshots = {} as LoadingSceneSnapshots;
        (["perspective", "top", "side", "door"] as const).forEach(view => {
          const aspect = view === "perspective" ? 16 / 9 : view === "top"
            ? size.x / size.z : view === "side" ? size.x / size.y : size.z / size.y;
          const exportWidth = view === "door" ? 1800 : 3000;
          const exportHeight = Math.max(480, Math.min(2000, Math.round(exportWidth / aspect)));
          renderer!.setSize(exportWidth, exportHeight, false);
          const exportCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 100);
          pose(exportCamera, view, exportWidth / exportHeight);
          ground.visible = view === "perspective";
          showDimensions(view);
          renderer!.render(scene, exportCamera);
          snapshots[view] = canvas.toDataURL("image/jpeg", .97);
        });
        ground.visible = currentView === "perspective";
        showDimensions(currentView);
        renderer!.setPixelRatio(ratio); renderer!.setSize(previousSize.x, previousSize.y, false);
        reveal(visibleRef.current ?? geometry.positions.length);
        onSnapshotsRef.current(snapshots); dirty = true;
      }, 120);
      queueMicrotask(() => setSceneError(""));
      return dispose;
    } catch (error) {
      dispose();
      queueMicrotask(() => setSceneError(error instanceof Error ? error.message : String(error)));
    }
  }, [geometry, mounted, plan.blocks, snapshotId, container.l, container.w, container.h, container.doorW, container.doorH, sideClearance, doorClearance, topClearance, doorWidth, doorHeight, palletOnly]);

  useEffect(() => { runtimeRef.current?.reveal(shown); }, [shown]);
  useEffect(() => { runtimeRef.current?.interact(interaction); }, [interaction]);

  return <section ref={sectionRef} className="loading-scene-3d" aria-label={en ? "Interactive cargo view" : "交互式货物装柜实景"}>
    <div className="loading-scene-heading">
      <div><span>MEGEE · CARGO STUDIO / 6.2</span>
        <h4>{palletOnly ? en ? "Pallet packing" : "塑料托盘 · 排箱实景" : en ? "Inside the load" : "货物装柜实景"}</h4>
        <p>{palletOnly ? en ? "Actual carton coordinates · standard pallet template" : "真实箱位坐标 · 标准组托模板" : en ? "Solid references: closed front, floor and far wall. Roof, near wall and door end remain open." : "实体参照：靠车头前壁、箱底、远侧壁；顶面、近侧面及柜门端敞开。"}</p>
      </div>
    </div>
    <div className="loading-scene-scale"><b>{palletOnly ? en ? "LOADED UNIT" : "组托设计外廓" : en ? "EFFECTIVE LOADING SPACE" : "有效装载空间 · 长 × 宽 × 高"}</b>
      <span>{effectiveLength.toLocaleString()} × {(container.w - sideClearance * 2).toLocaleString()} × {(container.h - topClearance).toLocaleString()} mm</span>
    </div>
    <div className="scene-camera-toolbar">
      <div className="scene-camera-presets" role="group" aria-label={en ? "3D and three orthographic views" : "立体及三视图切换"}>
        {(["perspective", "top", "side", "door"] as const).map(view =>
          <button type="button" key={view} data-scene-view={view} aria-pressed={activeView === view}
            onClick={() => selectView(view)}>
            {({ perspective: en ? "3D" : "立体", top: en ? "Top view" : "俯视图", side: en ? "Side view" : "侧视图", door: en ? "Door view" : "门视图" })[view]}
          </button>)}
      </div>
      <div className="scene-manipulation-controls"><button type="button" aria-pressed={interaction} onClick={() => setInteraction(v => !v)}>{interaction ? en ? "Finish interaction" : "结束模型操作" : en ? "Interact with model" : "操作模型"}</button><button type="button" aria-label={en ? "Zoom in" : "放大模型"} onClick={() => runtimeRef.current?.zoom(1.2)}>＋</button><button type="button" aria-label={en ? "Zoom out" : "缩小模型"} onClick={() => runtimeRef.current?.zoom(1/1.2)}>−</button><button type="button" onClick={() => selectView(activeView)}>{en ? "Fit view" : "完整显示"}</button></div>
      <p>{interaction ? en ? "Interaction enabled; standard views lock rotation" : "已开启模型操作；标准三视图锁定旋转" : en ? "Scroll the page normally. Select “Interact with model” to rotate or zoom." : "默认滚动网页；点击“操作模型”后才允许旋转或滚轮缩放。"}</p>
    </div>
    <div className={`loading-scene-stage view-${activeView}`}>
      <canvas ref={canvasRef} style={{ touchAction: interaction ? "none" : "auto" }} aria-label={en ? "Actual carton and pallet geometry" : "按实际坐标生成的纸箱和托盘"} />
      {sceneError ? <div className="loading-scene-error"><b>{en ? "3D unavailable" : "三维预览暂不可用"}</b><span>{sceneError}</span></div> : null}
    </div>
    <div className="loading-scene-status">
      <div className="loading-scene-badge loading-scene-badge-front">{palletOnly ? en ? "STANDARD PALLET COLUMN" : "标准组托模板" : en ? "FRONT → DOOR" : "箱头 → 柜门"}</div>
      <div className="loading-scene-badge loading-scene-badge-door" role="status">
        {shown < geometry.positions.length ? (en ? "LOADING · " : "装载中 · ") + shown + "/" + geometry.positions.length
          : en ? "COMPLETE LOAD" : "完整装载状态"}</div>
    </div>
    <div className="loading-scene-legend">
      {plan.blocks.map((b, i) => <span key={b.item.id}><i style={{ backgroundColor: SCENE_COLORS[i % SCENE_COLORS.length] }} />
        <b>{b.item.code || b.item.name}</b>{b.loadedBoxes.toLocaleString()} BOX</span>)}
      <em>{en ? "SKU colours are identification tints, not actual packaging print colours. Red tape = partial carton. "
        : "外箱颜色仅用于区分 SKU，不代表实物印刷色；红色胶带标记尾箱。"}
        {doorWidth && doorHeight && !palletOnly ? (en ? "Door: " : "参考门洞：") + doorWidth + " × " + doorHeight + " mm。" : ""}
        {!palletOnly ? (en ? "Reference faces follow measured interior dimensions; surface ribs are illustrative. Blue = effective loading limits; amber = door aperture. " : "参照面按柜内尺寸绘制，波纹细节仅为示意；蓝色为有效装载边界，琥珀色为门洞。") : ""}
        {en ? "Packing sequence is not a collision-checked loading path." : "演示表示装载顺序，不代表已验证叉车或搬运路径。"}</em>
    </div>
  </section>;
}
