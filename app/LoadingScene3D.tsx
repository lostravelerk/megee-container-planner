"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Dimensions, Language } from "./plannerTypes";

type PalletPatternPosition = {
  x: number;
  y: number;
  w: number;
  h: number;
  rotated: boolean;
};

type PalletLoad = {
  level: number;
  cartons: number;
};

type SceneItem = {
  id: string;
  code: string;
  name: string;
  eaPerBox: number;
  packaging: "carton" | "pallet";
  carton: Dimensions;
  pallet: Dimensions;
  loadingUnit: Dimensions;
  palletPlan: {
    cartonsPerLayer: number;
    cargoEnvelopeL: number;
    cargoEnvelopeW: number;
    stackHeight: number;
    positions: PalletPatternPosition[];
  };
};

type ScenePosition = {
  x: number;
  y: number;
  w: number;
  h: number;
  rotated: boolean;
  stackBoxes: number;
  skuId: string;
  palletLoads?: PalletLoad[];
  partialCartonEa?: number;
  partialOnTop?: boolean;
};

type SceneBlock = {
  item: SceneItem;
  loadedBoxes: number;
  startX?: number;
  length?: number;
  interlockedWithPrevious?: boolean;
};

type MixedContainerPlan = {
  index?: number;
  positions: ScenePosition[];
  blocks: SceneBlock[];
};

export type LoadingSceneSnapshots = {
  perspective: string;
  top: string;
  side: string;
  door: string;
};

const SCENE_COLORS = [
  "#79afe0",
  "#8dcdb0",
  "#b49eb8",
  "#86bec7",
  "#c6b78f",
  "#9aafc5",
  "#a3c2a8",
  "#bea09e",
];

type SceneProps = {
  plan: MixedContainerPlan;
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
};

type SceneRuntime = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  renderer: THREE.WebGLRenderer;
  cargoGroups: THREE.Group[];
  nearSideGroup: THREE.Group;
  roofGroup: THREE.Group;
  markViewAdjusted: () => void;
  homePosition: THREE.Vector3;
  homeTarget: THREE.Vector3;
  viewPositions: Record<"perspective" | "top" | "side" | "door", THREE.Vector3>;
};

function colorWithLightness(source: string, lightnessDelta: number) {
  const color = new THREE.Color(source);
  color.offsetHSL(0, 0, lightnessDelta);
  return color;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.closePath();
}

function createCartonMaterials(color: string, code: string, eaPerBox: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 420;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 640, 420);
    gradient.addColorStop(0, colorWithLightness(color, 0.1).getStyle());
    gradient.addColorStop(1, colorWithLightness(color, -0.02).getStyle());
    context.fillStyle = gradient;
    roundedRect(context, 4, 4, 632, 412, 20);
    context.fill();
    context.strokeStyle = "rgba(29,55,73,.34)";
    context.lineWidth = 8;
    context.stroke();
    context.fillStyle = "rgba(255,255,255,.32)";
    context.fillRect(294, 5, 52, 410);
    context.fillStyle = "#18364b";
    context.textAlign = "center";
    context.textBaseline = "middle";
    const safeCode = code || "SKU";
    const fontSize = Math.max(42, Math.min(82, 550 / Math.max(5, safeCode.length * 0.7)));
    context.font = `800 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    context.fillText(safeCode, 320, 170, 540);
    context.fillStyle = "rgba(24,54,75,.68)";
    context.font = "700 38px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    context.fillText(`THIS SIDE UP  ↑  ↑`, 320, 255, 540);
    context.font = "650 31px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    context.fillText(`${eaPerBox.toLocaleString()} EA / BOX`, 320, 318, 540);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const base = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.72,
    metalness: 0.01,
  });
  const side = new THREE.MeshStandardMaterial({
    color: colorWithLightness(color, -0.07),
    roughness: 0.76,
    metalness: 0.01,
  });
  const top = new THREE.MeshStandardMaterial({
    color: colorWithLightness(color, 0.1),
    roughness: 0.7,
    metalness: 0,
  });
  const front = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.7,
    metalness: 0,
  });
  return {
    materials: [side, side, top, base, front, base] as THREE.Material[],
    disposable: [base, side, top, front] as THREE.Material[],
    texture,
  };
}

function addBox(
  parent: THREE.Object3D,
  unitGeometry: THREE.BoxGeometry,
  materials: THREE.Material[],
  size: THREE.Vector3,
  position: THREE.Vector3,
) {
  // BoxGeometry has six material groups. A one-item array paints only one
  // group, which makes container walls, doors and pallet rails look like flat
  // lines. Collapse it to a single material so all physical faces render.
  const mesh = new THREE.Mesh(
    unitGeometry,
    materials.length === 1 ? materials[0] : materials,
  );
  mesh.position.copy(position);
  mesh.scale.copy(size);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function addDashedBox(parent: THREE.Object3D, size: THREE.Vector3, center: THREE.Vector3, color: string) {
  const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z));
  const material = new THREE.LineDashedMaterial({ color, dashSize: 0.13, gapSize: 0.075, transparent: true, opacity: 0.82 });
  const lines = new THREE.LineSegments(geometry, material);
  lines.position.copy(center);
  lines.computeLineDistances();
  lines.renderOrder = 8;
  parent.add(lines);
  return lines;
}

function addTailTape(
  parent: THREE.Object3D,
  unitGeometry: THREE.BoxGeometry,
  material: THREE.MeshStandardMaterial,
  center: THREE.Vector3,
  size: THREE.Vector3,
) {
  const band = Math.max(0.025, Math.min(size.x, size.z) * 0.085);
  addBox(
    parent,
    unitGeometry,
    [material],
    new THREE.Vector3(band, 0.012, size.z * 1.012),
    new THREE.Vector3(center.x, center.y + size.y / 2 + 0.008, center.z),
  );
  addBox(
    parent,
    unitGeometry,
    [material],
    new THREE.Vector3(size.x * 1.012, 0.013, band),
    new THREE.Vector3(center.x, center.y + size.y / 2 + 0.009, center.z),
  );
  addBox(
    parent,
    unitGeometry,
    [material],
    new THREE.Vector3(0.013, size.y * 1.01, band),
    new THREE.Vector3(center.x + size.x / 2 + 0.008, center.y, center.z),
  );
}

function createTextSprite(
  text: string,
  foreground: string,
  background: string,
  disposableMaterials: THREE.Material[],
  disposableTextures: THREE.Texture[],
) {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 192;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = background;
    roundedRect(context, 7, 7, 754, 178, 30);
    context.fill();
    context.strokeStyle = foreground;
    context.lineWidth = 9;
    context.stroke();
    context.fillStyle = foreground;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = "800 64px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    context.fillText(text, 384, 99, 700);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.92, 0.23, 1);
  sprite.renderOrder = 12;
  disposableMaterials.push(material);
  disposableTextures.push(texture);
  return sprite;
}

function addPlasticPallet(
  parent: THREE.Group,
  centerX: number,
  centerZ: number,
  baseY: number,
  length: number,
  width: number,
  height: number,
  rotated: boolean,
  unitGeometry: THREE.BoxGeometry,
  material: THREE.MeshStandardMaterial,
) {
  const palletLength = rotated ? width : length;
  const palletWidth = rotated ? length : width;
  const deckHeight = Math.max(0.035, height * 0.28);
  const runnerHeight = Math.max(0.035, height * 0.34);
  const railWidth = Math.max(0.045, palletWidth * 0.105);
  for (let index = 0; index < 6; index += 1) {
    const z = centerZ - palletWidth / 2 + railWidth / 2
      + index * ((palletWidth - railWidth) / 5);
    addBox(
      parent,
      unitGeometry,
      [material],
      new THREE.Vector3(palletLength, deckHeight, railWidth),
      new THREE.Vector3(centerX, baseY + height - deckHeight / 2, z),
    );
  }
  const footSizeX = Math.min(0.16, palletLength * 0.14);
  const footSizeZ = Math.min(0.16, palletWidth * 0.19);
  for (const xFactor of [-0.38, 0, 0.38]) {
    for (const zFactor of [-0.34, 0, 0.34]) {
      addBox(
        parent,
        unitGeometry,
        [material],
        new THREE.Vector3(footSizeX, runnerHeight, footSizeZ),
        new THREE.Vector3(
          centerX + palletLength * xFactor,
          baseY + runnerHeight / 2,
          centerZ + palletWidth * zFactor,
        ),
      );
    }
  }
}

export default function LoadingScene3D({
  plan,
  container,
  sideClearance,
  doorClearance,
  topClearance = 0,
  doorWidth,
  doorHeight,
  language,
  visiblePositionCount,
  eager = false,
  snapshotId = "",
  onSnapshots,
}: SceneProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const previousVisibleRef = useRef(visiblePositionCount ?? plan.positions.length);
  const visiblePositionCountRef = useRef(visiblePositionCount);
  const [sceneError, setSceneError] = useState("");
  const [sceneMounted, setSceneMounted] = useState(eager);
  const [activeView, setActiveView] = useState<"perspective" | "top" | "side" | "door">("perspective");
  const onSnapshotsRef = useRef(onSnapshots);
  const isEnglish = language === "en";
  const orderedPositions = useMemo(
    () => [...plan.positions].sort((left, right) => left.x - right.x || left.y - right.y),
    [plan.positions],
  );
  visiblePositionCountRef.current = visiblePositionCount;
  onSnapshotsRef.current = onSnapshots;

  useEffect(() => {
    if (eager) {
      queueMicrotask(() => setSceneMounted(true));
      return;
    }
    const section = sectionRef.current;
    if (!section) return;
    if (!("IntersectionObserver" in window)) {
      queueMicrotask(() => setSceneMounted(true));
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setSceneMounted(true);
        observer.disconnect();
      },
      { rootMargin: "480px" },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, [eager]);

  useEffect(() => {
    if (!sceneMounted) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    queueMicrotask(() => setSceneError(""));
    let disposed = false;
    let frame = 0;
    let sceneIsVisible = true;
    const disposableMaterials: THREE.Material[] = [];
    const disposableTextures: THREE.Texture[] = [];
    const unitGeometry = new THREE.BoxGeometry(1, 1, 1);

    try {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color("#eef3f7");
      scene.fog = new THREE.Fog("#eef3f7", 15, 29);
      const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        preserveDrawingBuffer: true,
        powerPreference: "high-performance",
      });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));

      const length = container.l / 1000;
      const width = container.w / 1000;
      const height = container.h / 1000;
      const camera = new THREE.PerspectiveCamera(29, 1, 0.05, 70);
      const homePosition = new THREE.Vector3(
        length * 0.025,
        height * 1.1,
        Math.max(width * 3, length * 1.28),
      );
      const homeTarget = new THREE.Vector3(0, height * 0.44, 0);
      const viewPositions = {
        perspective: homePosition,
        top: new THREE.Vector3(0, Math.max(length * 1.45, height * 5), 0.002),
        side: new THREE.Vector3(0, height * 0.5, Math.max(length * 1.45, width * 4)),
        door: new THREE.Vector3(length * 0.92, height * 0.5, 0.001),
      };
      camera.position.copy(homePosition);
      camera.lookAt(homeTarget);

      const controls = new OrbitControls(camera, canvas);
      controls.target.copy(homeTarget);
      controls.enableDamping = true;
      controls.dampingFactor = 0.075;
      controls.rotateSpeed = 0.55;
      controls.zoomSpeed = 0.7;
      controls.panSpeed = 0.45;
      controls.minDistance = Math.max(5, length * 0.72);
      controls.maxDistance = Math.max(18, length * 1.9);
      controls.minPolarAngle = 0.02;
      controls.maxPolarAngle = Math.PI * 0.73;
      controls.zoomToCursor = true;
      controls.update();
      let userAdjustedCamera = false;
      const markCameraAdjusted = () => {
        userAdjustedCamera = true;
        setActiveView("perspective");
      };
      controls.addEventListener("start", markCameraAdjusted);

      scene.add(new THREE.HemisphereLight("#ffffff", "#8c9aa4", 2.2));
      const keyLight = new THREE.DirectionalLight("#fff9ef", 3.7);
      keyLight.position.set(-length * 0.28, height * 3.6, width * 2.8);
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(2048, 2048);
      keyLight.shadow.camera.left = -length * 0.7;
      keyLight.shadow.camera.right = length * 0.7;
      keyLight.shadow.camera.top = width * 2;
      keyLight.shadow.camera.bottom = -width * 2;
      keyLight.shadow.bias = -0.00025;
      scene.add(keyLight);
      const fillLight = new THREE.DirectionalLight("#b9d8ff", 1.4);
      fillLight.position.set(length * 0.45, height * 1.2, -width * 2.2);
      scene.add(fillLight);

      const metal = new THREE.MeshStandardMaterial({
        color: "#d7dee3",
        roughness: 0.32,
        metalness: 0.66,
      });
      const metalDark = new THREE.MeshStandardMaterial({
        color: "#87949d",
        roughness: 0.38,
        metalness: 0.72,
      });
      const wall = new THREE.MeshStandardMaterial({
        color: "#d8e0e5",
        roughness: 0.58,
        metalness: 0.18,
        side: THREE.DoubleSide,
      });
      const roof = new THREE.MeshPhysicalMaterial({
        color: "#f4f7f8",
        roughness: 0.34,
        metalness: 0.2,
        transparent: true,
        opacity: 0.28,
        side: THREE.DoubleSide,
      });
      const cutawayWall = new THREE.MeshPhysicalMaterial({
        color: "#cfd9df",
        roughness: 0.45,
        metalness: 0.28,
        transparent: true,
        opacity: 0.11,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const doorMaterial = new THREE.MeshStandardMaterial({
        color: "#aebbc4",
        roughness: 0.46,
        metalness: 0.62,
        side: THREE.DoubleSide,
      });
      const redTapeMaterial = new THREE.MeshStandardMaterial({
        color: "#d62f2f",
        roughness: 0.48,
        metalness: 0.02,
        emissive: "#5b0505",
        emissiveIntensity: 0.12,
      });
      const separatorMaterial = new THREE.MeshBasicMaterial({
        color: "#245d86",
        transparent: true,
        opacity: 0.17,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const floorMaterial = new THREE.MeshStandardMaterial({
        color: "#7d7164",
        roughness: 0.9,
        metalness: 0.02,
      });
      const dockMaterial = new THREE.MeshStandardMaterial({
        color: "#e6ebef",
        roughness: 0.96,
        metalness: 0,
      });
      const clearanceMaterial = new THREE.MeshStandardMaterial({
        color: "#e5a552",
        roughness: 0.8,
        metalness: 0,
        transparent: true,
        opacity: 0.42,
      });
      const palletMaterial = new THREE.MeshStandardMaterial({
        color: "#4f6f82",
        roughness: 0.62,
        metalness: 0.12,
      });
      disposableMaterials.push(
        metal, metalDark, wall, roof, cutawayWall, doorMaterial, redTapeMaterial,
        separatorMaterial, floorMaterial, dockMaterial, clearanceMaterial, palletMaterial,
      );

      const containerShell = new THREE.Group();
      const nearSideGroup = new THREE.Group();
      const roofGroup = new THREE.Group();
      const doorGroup = new THREE.Group();
      scene.add(containerShell, nearSideGroup, roofGroup, doorGroup);
      addBox(scene, unitGeometry, [dockMaterial], new THREE.Vector3(length + 4.4, 0.08, width + 5.2), new THREE.Vector3(0.65, -0.18, 0.38));
      addBox(containerShell, unitGeometry, [metalDark], new THREE.Vector3(length + 0.12, 0.1, width + 0.12), new THREE.Vector3(0, -0.06, 0));
      addBox(containerShell, unitGeometry, [floorMaterial], new THREE.Vector3(length, 0.045, width), new THREE.Vector3(0, 0, 0));

      for (let index = 0; index < 18; index += 1) {
        const z = -width / 2 + (index + 0.5) * (width / 18);
        addBox(containerShell, unitGeometry, [metalDark], new THREE.Vector3(length, 0.012, 0.012), new THREE.Vector3(0, 0.03, z));
      }
      addBox(containerShell, unitGeometry, [wall], new THREE.Vector3(length, height, 0.035), new THREE.Vector3(0, height / 2, -width / 2 - 0.02));
      addBox(containerShell, unitGeometry, [wall], new THREE.Vector3(0.04, height, width), new THREE.Vector3(-length / 2 - 0.02, height / 2, 0));
      addBox(nearSideGroup, unitGeometry, [cutawayWall], new THREE.Vector3(length, height, 0.024), new THREE.Vector3(0, height / 2, width / 2 + 0.018));
      addBox(roofGroup, unitGeometry, [roof], new THREE.Vector3(length, 0.035, width), new THREE.Vector3(0, height + 0.02, 0));

      for (let x = -length / 2 + 0.2; x < length / 2; x += 0.58) {
        addBox(containerShell, unitGeometry, [metal], new THREE.Vector3(0.035, height * 0.93, 0.026), new THREE.Vector3(x, height * 0.51, -width / 2 + 0.006));
        addBox(nearSideGroup, unitGeometry, [metal], new THREE.Vector3(0.026, height * 0.93, 0.024), new THREE.Vector3(x, height * 0.51, width / 2 - 0.006));
      }
      // ISO-style corrugation and roof bows: dimensions sit outside the stated
      // clear interior and therefore never reduce the loading calculation.
      for (let x = -length / 2 + 0.26; x < length / 2; x += 0.42) {
        addBox(containerShell, unitGeometry, [metal], new THREE.Vector3(0.035, 0.055, width), new THREE.Vector3(x, height + 0.008, 0));
      }
      for (let z = -width / 2 + 0.18; z < width / 2; z += 0.31) {
        addBox(containerShell, unitGeometry, [metal], new THREE.Vector3(0.035, height * 0.9, 0.035), new THREE.Vector3(-length / 2 + 0.004, height * 0.5, z));
      }
      for (const z of [-width / 2, width / 2]) {
        const isNearCutawayEdge = z > 0;
        const railMaterial = isNearCutawayEdge ? metalDark : metal;
        addBox(
          z > 0 ? nearSideGroup : containerShell,
          unitGeometry,
          [railMaterial],
          new THREE.Vector3(length + 0.15, isNearCutawayEdge ? 0.11 : 0.075, isNearCutawayEdge ? 0.105 : 0.075),
          new THREE.Vector3(0, 0.05, z),
        );
        addBox(
          z > 0 ? nearSideGroup : containerShell,
          unitGeometry,
          [railMaterial],
          new THREE.Vector3(length + 0.15, isNearCutawayEdge ? 0.12 : 0.085, isNearCutawayEdge ? 0.11 : 0.085),
          new THREE.Vector3(0, height, z),
        );
      }
      for (const x of [-length / 2, length / 2]) {
        for (const z of [-width / 2, width / 2]) {
          addBox(containerShell, unitGeometry, [metalDark], new THREE.Vector3(0.105, height + 0.16, 0.105), new THREE.Vector3(x, height / 2, z));
        }
      }
      addBox(containerShell, unitGeometry, [metalDark], new THREE.Vector3(0.12, 0.11, width + 0.18), new THREE.Vector3(length / 2, 0.06, 0));
      addBox(containerShell, unitGeometry, [metal], new THREE.Vector3(0.1, 0.12, width + 0.18), new THREE.Vector3(length / 2, height, 0));

      // Open double doors with inner panels, corrugations, hinges and locking
      // bars.  They make the loading end unmistakable while keeping the door
      // opening unobstructed for the dimensional simulation.
      const addOpenDoor = (z: number, direction: 1 | -1) => {
        const pivot = new THREE.Group();
        pivot.position.set(length / 2 + 0.035, 0, z);
        pivot.rotation.y = direction * Math.PI * 0.5;
        const leafWidth = width / 2 - 0.045;
        const localCenterZ = -direction * leafWidth / 2;
        addBox(pivot, unitGeometry, [doorMaterial], new THREE.Vector3(0.045, height - 0.1, leafWidth), new THREE.Vector3(0, height / 2, localCenterZ));
        for (let offset = 0.12; offset < leafWidth; offset += 0.29) {
          addBox(pivot, unitGeometry, [metal], new THREE.Vector3(0.058, height - 0.2, 0.022), new THREE.Vector3(-0.012, height / 2, localCenterZ - leafWidth / 2 + offset));
        }
        for (const barOffset of [-0.18, 0.18]) {
          addBox(pivot, unitGeometry, [metalDark], new THREE.Vector3(0.065, height - 0.22, 0.035), new THREE.Vector3(-0.04, height / 2, localCenterZ + barOffset));
        }
        doorGroup.add(pivot);
      };
      addOpenDoor(-width / 2, 1);
      addOpenDoor(width / 2, -1);
      const clearanceLength = Math.min(length, doorClearance / 1000);
      if (clearanceLength > 0.02) {
        addBox(
          scene,
          unitGeometry,
          [clearanceMaterial],
          new THREE.Vector3(clearanceLength, 0.025, width * 0.96),
          new THREE.Vector3(length / 2 - clearanceLength / 2, 0.055, 0),
        );
      }
      const effectiveLength = Math.max(0.01, length - clearanceLength);
      const effectiveWidth = Math.max(0.01, width - sideClearance * 2 / 1000);
      const effectiveHeight = Math.max(0.01, height - topClearance / 1000);
      addDashedBox(
        scene,
        new THREE.Vector3(effectiveLength, effectiveHeight, effectiveWidth),
        new THREE.Vector3(-clearanceLength / 2, effectiveHeight / 2 + 0.018, 0),
        "#1671c8",
      );

      plan.blocks.slice(1).forEach((block) => {
        const boundaryX = Number(block.startX ?? 0) / 1000 - length / 2;
        const geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(boundaryX, 0.065, -effectiveWidth / 2),
          new THREE.Vector3(boundaryX, 0.065, effectiveWidth / 2),
        ]);
        const material = new THREE.LineDashedMaterial({
          color: "#245d86",
          dashSize: 0.1,
          gapSize: 0.055,
          transparent: true,
          opacity: 0.9,
        });
        const boundary = new THREE.Line(geometry, material);
        boundary.computeLineDistances();
        boundary.renderOrder = 9;
        scene.add(boundary);
      });

      const materialBundles = plan.blocks.map((block, index) => {
        const bundle = createCartonMaterials(
          SCENE_COLORS[index % SCENE_COLORS.length],
          block.item.code || block.item.name,
          block.item.eaPerBox,
        );
        disposableMaterials.push(...bundle.disposable);
        disposableTextures.push(bundle.texture);
        return bundle;
      });

      const cargoGroups = orderedPositions.map((position) => {
        const blockIndex = Math.max(0, plan.blocks.findIndex((block) => block.item.id === position.skuId));
        const block = plan.blocks[blockIndex];
        const item = block.item;
        const group = new THREE.Group();
        const floorCenterX = position.x / 1000 - length / 2 + position.w / 2000;
        const floorCenterZ = (position.y + sideClearance) / 1000 - width / 2 + position.h / 2000;
        if (item.packaging === "pallet") {
          const palletLoads = position.palletLoads ?? [];
          palletLoads.forEach((load, loadIndex) => {
            const palletBaseY = (load.level - 1) * item.loadingUnit.h / 1000 + 0.025;
            addPlasticPallet(
              group,
              floorCenterX,
              floorCenterZ,
              palletBaseY,
              item.pallet.l / 1000,
              item.pallet.w / 1000,
              item.pallet.h / 1000,
              position.rotated,
              unitGeometry,
              palletMaterial,
            );
            let cartonsLeft = load.cartons;
            const layerCapacity = item.palletPlan.cartonsPerLayer;
            const layerCount = Math.ceil(cartonsLeft / Math.max(1, layerCapacity));
            for (let layer = 0; layer < layerCount; layer += 1) {
              const boxesThisLayer = Math.min(layerCapacity, cartonsLeft);
              item.palletPlan.positions.slice(0, boxesThisLayer).forEach((cartonPosition, cartonIndex) => {
                const cartonLength = (cartonPosition.rotated ? item.carton.w : item.carton.l) / 1000;
                const cartonWidth = (cartonPosition.rotated ? item.carton.l : item.carton.w) / 1000;
                const localX = (cartonPosition.x + (cartonPosition.w / 2) - item.palletPlan.cargoEnvelopeL / 2) / 1000;
                const localZ = (cartonPosition.y + (cartonPosition.h / 2) - item.palletPlan.cargoEnvelopeW / 2) / 1000;
                const worldX = position.rotated ? floorCenterX - localZ : floorCenterX + localX;
                const worldZ = position.rotated ? floorCenterZ + localX : floorCenterZ + localZ;
                const worldLength = position.rotated ? cartonWidth : cartonLength;
                const worldWidth = position.rotated ? cartonLength : cartonWidth;
                const cartonHeight = item.carton.h / 1000;
                const layerPitch = item.carton.h / 1000 + Math.max(0, item.loadingUnit.h - item.palletPlan.stackHeight) / 1000;
                const worldY = palletBaseY + item.pallet.h / 1000 + layer * layerPitch + cartonHeight / 2;
                const cartonCenter = new THREE.Vector3(worldX, worldY, worldZ);
                const cartonSize = new THREE.Vector3(worldLength * 0.985, cartonHeight * 0.985, worldWidth * 0.985);
                addBox(
                  group,
                  unitGeometry,
                  materialBundles[blockIndex].materials,
                  cartonSize,
                  cartonCenter,
                );
                const isTailCarton = Boolean(
                  position.partialCartonEa
                    && loadIndex === palletLoads.length - 1
                    && layer === layerCount - 1
                    && cartonIndex === boxesThisLayer - 1,
                );
                if (isTailCarton) addTailTape(group, unitGeometry, redTapeMaterial, cartonCenter, cartonSize);
              });
              cartonsLeft -= boxesThisLayer;
            }
          });
        } else {
          const actualLength = (position.rotated ? item.carton.w : item.carton.l) / 1000;
          const actualWidth = (position.rotated ? item.carton.l : item.carton.w) / 1000;
          const actualHeight = item.carton.h / 1000;
          const pitch = item.loadingUnit.h / 1000;
          for (let layer = 0; layer < position.stackBoxes; layer += 1) {
            const cartonCenter = new THREE.Vector3(
              floorCenterX,
              0.025 + layer * pitch + actualHeight / 2,
              floorCenterZ,
            );
            const cartonSize = new THREE.Vector3(actualLength * 0.985, actualHeight * 0.985, actualWidth * 0.985);
            addBox(
              group,
              unitGeometry,
              materialBundles[blockIndex].materials,
              cartonSize,
              cartonCenter,
            );
            if (position.partialCartonEa && layer === position.stackBoxes - 1)
              addTailTape(group, unitGeometry, redTapeMaterial, cartonCenter, cartonSize);
          }
        }
        if (position.partialCartonEa) {
          const label = createTextSprite(
            `${isEnglish ? "TAIL" : "尾箱"} · ${position.partialCartonEa} EA`,
            "#a4161a",
            "rgba(255,247,244,.96)",
            disposableMaterials,
            disposableTextures,
          );
          label.position.set(
            floorCenterX,
            Math.min(height - 0.08, position.stackBoxes * item.loadingUnit.h / 1000 + 0.32),
            floorCenterZ,
          );
          group.add(label);
        }
        group.visible = false;
        group.userData.entryOffset = Math.max(1.2, length * 0.18);
        scene.add(group);
        return group;
      });

      const resize = () => {
        if (disposed || !canvas.parentElement) return;
        const rect = canvas.parentElement.getBoundingClientRect();
        const sceneWidth = Math.max(320, Math.round(rect.width));
        const sceneHeight = Math.max(260, Math.round(rect.height));
        renderer.setSize(sceneWidth, sceneHeight, false);
        camera.aspect = sceneWidth / sceneHeight;
        const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
        const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
        const responsiveDistance = Math.max(
          width * 3,
          (length * 0.56) / Math.max(0.08, Math.tan(horizontalHalfFov)),
        );
        homePosition.set(length * 0.025, height * 1.1, responsiveDistance);
        viewPositions.side.set(0, height * 0.5, Math.max(responsiveDistance, length * 1.35));
        viewPositions.top.set(0, Math.max(responsiveDistance * 1.08, length * 1.45), 0.002);
        viewPositions.door.set(Math.max(length * 0.92, width * 4.2), height * 0.5, 0.001);
        if (!userAdjustedCamera) {
          camera.position.copy(homePosition);
          camera.lookAt(homeTarget);
          controls.target.copy(homeTarget);
          controls.update();
        }
        camera.updateProjectionMatrix();
      };
      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(canvas.parentElement);
      resize();
      const intersectionObserver = new IntersectionObserver(
        ([entry]) => { sceneIsVisible = entry?.isIntersecting ?? true; },
        { rootMargin: "240px" },
      );
      intersectionObserver.observe(canvas);

      const captureSnapshots = () => {
        if (disposed || !onSnapshotsRef.current) return;
        const originalSize = renderer.getSize(new THREE.Vector2());
        const originalPixelRatio = renderer.getPixelRatio();
        const originalVisibility = cargoGroups.map((group) => group.visible);
        const originalOffsets = cargoGroups.map((group) => group.position.x);
        const originalFog = scene.fog;
        const originalNearSideVisibility = nearSideGroup.visible;
        const originalRoofVisibility = roofGroup.visible;
        // Orthographic export cameras sit farther away to avoid clipping. Fog
        // is a screen-depth effect, not part of the dimensional model, so it
        // must be disabled for crisp evidentiary report plates.
        scene.fog = null;
        cargoGroups.forEach((group) => {
          group.visible = true;
          group.position.x = 0;
        });
        const exportWidth = 1440;
        const exportHeight = 860;
        const aspect = exportWidth / exportHeight;
        renderer.setPixelRatio(1);
        renderer.setSize(exportWidth, exportHeight, false);

        const renderPerspective = () => {
          nearSideGroup.visible = true;
          roofGroup.visible = true;
          const exportCamera = new THREE.PerspectiveCamera(31, aspect, 0.05, 90);
          exportCamera.position.set(length * 0.2, height * 1.18, Math.max(width * 3.2, length * 1.05));
          exportCamera.lookAt(new THREE.Vector3(0, height * 0.43, 0));
          renderer.render(scene, exportCamera);
          return canvas.toDataURL("image/jpeg", 0.9);
        };
        const renderOrthographic = (
          horizontalSpan: number,
          verticalSpan: number,
          position: THREE.Vector3,
          target: THREE.Vector3,
          up: THREE.Vector3,
          hideRoof: boolean,
          hideNearSide: boolean,
        ) => {
          const halfHeight = Math.max(verticalSpan * 0.58, horizontalSpan / aspect * 0.58);
          const halfWidth = halfHeight * aspect;
          const exportCamera = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 0.05, 100);
          exportCamera.position.copy(position);
          exportCamera.up.copy(up);
          exportCamera.lookAt(target);
          roofGroup.visible = !hideRoof;
          nearSideGroup.visible = !hideNearSide;
          renderer.render(scene, exportCamera);
          return canvas.toDataURL("image/jpeg", 0.92);
        };
        const snapshots: LoadingSceneSnapshots = {
          perspective: renderPerspective(),
          top: renderOrthographic(
            length + 0.35,
            width + 0.25,
            new THREE.Vector3(0, Math.max(length * 3, 24), 0.001),
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, -1),
            true,
            true,
          ),
          side: renderOrthographic(
            length + 0.35,
            height + 0.25,
            new THREE.Vector3(0, height / 2, Math.max(length * 3, 24)),
            new THREE.Vector3(0, height / 2, 0),
            new THREE.Vector3(0, 1, 0),
            true,
            true,
          ),
          door: renderOrthographic(
            width + 0.35,
            height + 0.25,
            new THREE.Vector3(Math.max(length * 3, 24), height / 2, 0),
            new THREE.Vector3(0, height / 2, 0),
            new THREE.Vector3(0, 1, 0),
            false,
            false,
          ),
        };
        nearSideGroup.visible = originalNearSideVisibility;
        roofGroup.visible = originalRoofVisibility;
        scene.fog = originalFog;
        renderer.setPixelRatio(originalPixelRatio);
        renderer.setSize(originalSize.x, originalSize.y, false);
        cargoGroups.forEach((group, index) => {
          group.visible = originalVisibility[index];
          group.position.x = originalOffsets[index];
        });
        renderer.render(scene, camera);
        onSnapshotsRef.current?.(snapshots);
      };

      const animate = () => {
        if (disposed) return;
        frame = window.requestAnimationFrame(animate);
        if (!sceneIsVisible || document.hidden) return;
        cargoGroups.forEach((group) => {
          if (!group.visible || Math.abs(group.position.x) < 0.001) return;
          group.position.x *= 0.82;
          if (Math.abs(group.position.x) < 0.001) group.position.x = 0;
        });
        controls.update();
        renderer.render(scene, camera);
      };
      animate();
      runtimeRef.current = {
        scene,
        camera,
        controls,
        renderer,
        cargoGroups,
        nearSideGroup,
        roofGroup,
        markViewAdjusted: () => { userAdjustedCamera = true; },
        homePosition,
        homeTarget,
        viewPositions,
      };
      const currentVisible = visiblePositionCountRef.current === undefined
        ? cargoGroups.length
        : Math.max(0, Math.min(cargoGroups.length, visiblePositionCountRef.current));
      cargoGroups.forEach((group, index) => { group.visible = index < currentVisible; });
      previousVisibleRef.current = currentVisible;
      const snapshotTimer = window.setTimeout(captureSnapshots, 160);

      return () => {
        disposed = true;
        window.clearTimeout(snapshotTimer);
        window.cancelAnimationFrame(frame);
        resizeObserver.disconnect();
        intersectionObserver.disconnect();
        controls.removeEventListener("start", markCameraAdjusted);
        controls.dispose();
        scene.traverse((object) => {
          if ((object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.LineSegments)
            && object.geometry !== unitGeometry) object.geometry.dispose();
          if ((object instanceof THREE.Line || object instanceof THREE.LineSegments) && object.material instanceof THREE.Material)
            object.material.dispose();
        });
        unitGeometry.dispose();
        disposableMaterials.forEach((material) => material.dispose());
        disposableTextures.forEach((texture) => texture.dispose());
        renderer.dispose();
        runtimeRef.current = null;
      };
    } catch (error) {
      queueMicrotask(() => setSceneError(error instanceof Error ? error.message : String(error)));
      return () => {
        disposed = true;
        window.cancelAnimationFrame(frame);
        unitGeometry.dispose();
        disposableMaterials.forEach((material) => material.dispose());
        disposableTextures.forEach((texture) => texture.dispose());
      };
    }
  }, [container.h, container.l, container.w, doorClearance, doorHeight, doorWidth, isEnglish, orderedPositions, plan.blocks, sceneMounted, sideClearance, snapshotId, topClearance]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.markViewAdjusted();
    const visible = visiblePositionCount === undefined
      ? runtime.cargoGroups.length
      : Math.max(0, Math.min(runtime.cargoGroups.length, visiblePositionCount));
    const previousVisible = previousVisibleRef.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    runtime.cargoGroups.forEach((group, index) => {
      group.visible = index < visible;
      if (index >= visible) group.position.x = 0;
      else if (!reducedMotion && index >= previousVisible) group.position.x = group.userData.entryOffset;
    });
    previousVisibleRef.current = visible;
  }, [visiblePositionCount, orderedPositions.length, plan]);

  const setStandardView = (view: "perspective" | "top" | "side" | "door") => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const dampingWasEnabled = runtime.controls.enableDamping;
    runtime.controls.enableDamping = false;
    runtime.controls.minPolarAngle = view === "top" ? 0 : 0.02;
    runtime.controls.maxPolarAngle = Math.PI;
    runtime.roofGroup.visible = view === "perspective" || view === "door";
    runtime.nearSideGroup.visible = view === "perspective" || view === "door";
    runtime.camera.up.set(0, 1, 0);
    if (view === "top") runtime.camera.up.set(0, 0, -1);
    runtime.camera.fov = view === "perspective" ? 29 : view === "door" ? 24 : 27;
    runtime.camera.position.copy(runtime.viewPositions[view]);
    runtime.controls.target.copy(runtime.homeTarget);
    if (view === "top") runtime.controls.target.set(0, 0, 0);
    runtime.camera.lookAt(runtime.controls.target);
    runtime.camera.updateProjectionMatrix();
    runtime.controls.update();
    runtime.renderer.render(runtime.scene, runtime.camera);
    runtime.controls.enableDamping = dampingWasEnabled;
    setActiveView(view);
  };

  return (
    <section ref={sectionRef} className="loading-scene-3d" aria-label={isEnglish ? "Interactive 3D loading scene" : "交互式三维装柜实景"}>
      <div className="loading-scene-heading">
        <div>
          <span>LIVE 3D</span>
          <h4>{isEnglish ? "REALISTIC LOADING SCENE" : "三维装柜实景"}</h4>
          <p>{isEnglish ? "ISO-style container shell · effective interior envelope · exact plan coordinates" : "ISO 柜体结构 · 有效内尺寸边界 · 按真实坐标与包装尺寸生成"}</p>
        </div>
        <div className="loading-scene-actions">
          <span>{isEnglish ? "Drag to orbit · pinch or wheel to zoom" : "拖动旋转 · 双指或滚轮缩放"}</span>
          <div className="loading-scene-view-switch" role="group" aria-label={isEnglish ? "Standard camera views" : "标准观察视角"}>
            {(["perspective", "top", "side", "door"] as const).map((view) => (
              <button
                type="button"
                className={activeView === view ? "active" : ""}
                key={view}
                onClick={() => setStandardView(view)}
              >
                {view === "perspective"
                  ? isEnglish ? "3D" : "实景"
                  : view === "top"
                    ? isEnglish ? "TOP" : "俯视"
                    : view === "side"
                      ? isEnglish ? "SIDE" : "侧视"
                      : isEnglish ? "DOOR" : "门侧"}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="loading-scene-stage">
        {sceneError ? (
          <div className="loading-scene-error">
            <b>{isEnglish ? "3D preview unavailable" : "三维预览暂不可用"}</b>
            <span>{sceneError}</span>
          </div>
        ) : null}
        <canvas ref={canvasRef} />
        <div className="loading-scene-badge loading-scene-badge-front">{isEnglish ? "FRONT" : "箱头"}</div>
        <div className="loading-scene-badge loading-scene-badge-door">{isEnglish ? "DOOR / LOADING" : "箱门 / 装载端"}</div>
        <div className="loading-scene-scale">
          <b>{isEnglish ? "EFFECTIVE INTERIOR" : "有效装载内尺寸"}</b>
          <span>{((container.l - doorClearance) / 1000).toFixed(3)} m</span>
          <i />
          <span>{((container.w - sideClearance * 2) / 1000).toFixed(3)} m</span>
          <i />
          <span>{((container.h - topClearance) / 1000).toFixed(3)} m</span>
        </div>
      </div>
      <div className="loading-scene-legend">
        {plan.blocks.map((block, index) => (
          <span key={block.item.id}>
            <i style={{ backgroundColor: SCENE_COLORS[index % SCENE_COLORS.length] }} />
            <b>{block.item.code || block.item.name}</b>
            {block.loadedBoxes.toLocaleString()} BOX
          </span>
        ))}
        <em>
          {isEnglish
            ? `Dashed blue frame = effective loading envelope${doorWidth && doorHeight ? ` · door ${doorWidth} × ${doorHeight} mm` : ""}. Red tape = partial carton.`
            : `蓝色虚线框＝有效装载边界${doorWidth && doorHeight ? ` · 门洞 ${doorWidth} × ${doorHeight} mm` : ""}；红色封箱带＝尾箱。`}
        </em>
      </div>
    </section>
  );
}
