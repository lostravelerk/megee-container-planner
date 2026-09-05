import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CARTON, DEFAULT_PALLET, resolvePalletPolicy } from '../lib/palletPolicy.js';
import { planMixedContainers, validateMixedPlan } from '../lib/mixedPacking.js';
import { cartonCbmPerTenThousand } from '../lib/shipping.js';

const hq = {l:12032,w:2352,h:2698,doorW:2340,doorH:2597};
const gp = {l:5898,w:2352,h:2393,doorW:2340,doorH:2292};
const item = {id:'test',code:'TEST',series:'',name:'Test cartons',eaPerBox:600,
  productQuantity:21600,packaging:'pallet',carton:{...DEFAULT_CARTON},pallet:{...DEFAULT_PALLET},palletOverhang:0};

test('40HQ customer-selected double pallet uses three carton layers and two pallet tiers, including tolerance',()=>{
  const r=planMixedContainers([item],hq,{palletPreset:'hq-3x2'});
  assert.equal(r.items[0].palletPlan.cartonsPerLayer,6);
  assert.equal(r.items[0].palletPlan.layersPerPallet,3);
  assert.equal(r.items[0].palletPlan.stackLevels,2);
  assert.equal(r.items[0].palletPlan.stackHeight,1209);
  assert.equal(r.items[0].cartonsPerUnit,18);
  assert.equal(r.plannedBoxes,36);
  assert.equal(r.containers[0].positions.length,1);
  assert.equal(validateMixedPlan(r).ok,true);
});

test('40HQ customer-selected single pallet uses six layers without automatic substitution',()=>{
  const before=structuredClone(item);
  const r=planMixedContainers([item],hq,{palletPreset:'hq-6x1'});
  const p=r.items[0].palletPlan;
  assert.equal(p.cartonsPerLayer,6);
  assert.equal(p.layersPerPallet,6);
  assert.equal(p.stackLevels,1);
  assert.equal(p.stackHeight,2268);
  assert.equal(r.items[0].cartonsPerUnit,36);
  assert.equal(r.totalRequiredPallets,1);
  assert.equal(r.config.palletPreset,'hq-6x1');
  assert.equal(validateMixedPlan(r).ok,true);
  assert.deepEqual(item,before);
});

test('40HQ awaiting customer choice cannot generate a pallet loading result',()=>{
  const r=planMixedContainers([item],hq,{palletPreset:'hq-choice'});
  assert.equal(r.plannedBoxes,0);
  assert.equal(r.containers.length,0);
  assert.match(r.unplanned[0].reason,/Customer must select/);
  assert.equal(validateMixedPlan(r).ok,false);
  const cartons=planMixedContainers([{...item,packaging:'carton'}],hq,{palletPreset:'hq-choice'});
  assert.equal(cartons.plannedBoxes,36);
  assert.equal(validateMixedPlan(cartons).ok,true);
});

test('a selected double policy never switches to single even when only single fits',()=>{
  const source={...item,carton:{...item.carton,h:400}};
  const single=planMixedContainers([source],hq,{palletPreset:'hq-6x1'});
  const double=planMixedContainers([source],hq,{palletPreset:'hq-3x2'});
  assert.equal(single.plannedBoxes,36);
  assert.equal(validateMixedPlan(single).ok,true);
  assert.equal(double.plannedBoxes,0);
  assert.equal(double.config.palletPreset,'hq-3x2');
  assert.equal(validateMixedPlan(double).ok,false);
  assert.equal(source.carton.h,400);
});

test('factory preset has four layers, with design allowance distinct from nominal height',()=>{
  const r=planMixedContainers([item],hq,{palletPreset:'factory-4x1'});
  const p=r.items[0].palletPlan;
  assert.equal(p.layersPerPallet,4);
  assert.equal(p.stackLevels,1);
  assert.equal(p.stackHeight,1562);
  assert.equal(r.items[0].cartonsPerUnit,24);
  assert.equal(validateMixedPlan(r).ok,true);
  const tall=planMixedContainers([{...item,carton:{...item.carton,h:450}}],hq,{palletPreset:'factory-4x1'});
  assert.equal(tall.plannedBoxes,0);
});

test('CBM per 10000 EA uses entered quantity, never a PDF example or SKU override',()=>{
  assert.ok(Math.abs(cartonCbmPerTenThousand(DEFAULT_CARTON,1000)-0.6384)<1e-10);
  assert.ok(Math.abs(cartonCbmPerTenThousand(DEFAULT_CARTON,600)-1.064)<1e-10);
  for(const invalid of [0,-1,NaN,1.5]) assert.equal(cartonCbmPerTenThousand(DEFAULT_CARTON,invalid),null);
});

test('20GP and 40GP standard use five carton layers and single-tier pallets',()=>{
  for(const c of [gp,{...gp,l:12032}]) {
    const r=planMixedContainers([{...item,productQuantity:36000}],c,{palletPreset:'gp-5x1'});
    assert.equal(r.items[0].palletPlan.layersPerPallet,5);
    assert.equal(r.items[0].palletPlan.stackLevels,1);
    assert.equal(r.items[0].palletPlan.stackHeight,1915);
    assert.equal(r.items[0].cartonsPerUnit,30);
    assert.equal(r.plannedBoxes,60);
    assert.equal(validateMixedPlan(r).ok,true);
  }
});

test('fixed presets reject excessive heights instead of silently changing inputs or layers',()=>{
  for(const [c,preset] of [[hq,'hq-3x2'],[gp,'gp-5x1']]) {
    const source={...item,carton:{...item.carton,h:450}};
    const before=structuredClone(source);
    const r=planMixedContainers([source],c,{palletPreset:preset});
    assert.ok(r.unplanned.length);
    assert.equal(r.plannedBoxes,0);
    assert.deepEqual(source,before);
    assert.equal(r.items[0].eaPerBox,600);
  }
});

test('custom layers and tiers are enforced; invalid values fail closed',()=>{
  const r=planMixedContainers([item],hq,{palletPreset:'custom',palletLayers:2,palletStackLevels:1});
  assert.equal(r.items[0].palletPlan.stackHeight,856);
  assert.equal(r.items[0].palletPlan.layersPerPallet,2);
  assert.equal(validateMixedPlan(r).ok,true);
  for(const layers of [0,-1,2.5,NaN,51]) {
    const bad=planMixedContainers([item],hq,{palletPreset:'custom',palletLayers:layers,palletStackLevels:2});
    assert.ok(bad.unplanned.length);
  }
});

test('legacy snapshots retain auto search and existing height ranges',()=>{
  const p=resolvePalletPolicy({palletMinHeight:1100,palletHeightLimit:1700,allowDoubleStack:false},2648);
  assert.equal(p.palletPreset,'auto');
  assert.equal(p.palletLayers,0);
  assert.equal(p.palletHeightLimit,1700);
  assert.equal(p.allowDoubleStack,false);
});
