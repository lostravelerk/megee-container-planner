import test from 'node:test';
import assert from 'node:assert/strict';
import {cartonBatchMass,standardCartonNetKg,CARTON_WEIGHT_BASIS} from '../lib/cartonMass.js';
import {calculateShipment,confirmShipment} from '../lib/shipping.js';
import {planMixedContainers} from '../lib/mixedPacking.js';
import {auditPlanMass} from '../lib/planMass.js';
const line=(changes={})=>({id:'a',code:'X40402',name:'Test',quantity:1300,eaPerBox:600,l:480,w:380,h:350,grossKg:12,netKg:99,tailGrossKg:90,tailNetKg:80,...changes});
const draft=(changes={})=>({id:'s',schemaVersion:1,weightBasis:CARTON_WEIGHT_BASIS,status:'draft',reference:'QA',lines:[line()],pallets:[],...changes});
test('standard net is locked business subtraction, missing and invalid are not zero',()=>{
  assert.equal(standardCartonNetKg(7.5),6.5); assert.equal(standardCartonNetKg(1),0);
  for(const n of ['',null,undefined,0,.999,-1,NaN,Infinity]) assert.equal(standardCartonNetKg(n),null);
  assert.equal(cartonBatchMass(1,600,'').pending,true);
  assert.equal(cartonBatchMass(1,600,'').grossKg,null);
  assert.ok(cartonBatchMass(1,600,.9).error);
  assert.ok(cartonBatchMass(Number.MAX_SAFE_INTEGER,1,7).error);
  assert.ok(cartonBatchMass(1.5,600,7).error);
});
test('actual screenshot quantities produce 952 cartons and exact gross/net totals',()=>{
  const result=calculateShipment(draft({lines:[line({id:'a',code:'X40401',quantity:357000,eaPerBox:1000,grossKg:7.5}),line({id:'b',quantity:357000,grossKg:7})]}));
  assert.equal(result.ready,true); assert.equal(result.cartons.length,952);
  assert.equal(result.totalQuantity,714000);
  assert.equal(result.totalGrossKg,6842.5); assert.equal(result.totalNetKg,5890.5);
  assert.equal(result.lines[1].eaPerBox,600);
});
test('partials follow proportional net plus one carton tare, not stale measured overrides',()=>{
  const r=calculateShipment(draft());
  assert.equal(r.totalGrossKg,26.833); assert.equal(r.totalNetKg,23.833);
  assert.deepEqual(r.cartons.map(c=>c.grossKg),[12,12,2.833]);
  assert.equal(cartonBatchMass(1300,600,12).estimatedPartial,true);
  const minimum=cartonBatchMass(1,600,1);assert.equal(minimum.netKg,0);assert.equal(minimum.grossKg,1);
});
test('standard mode ignores pallet mass and payload, but preserves IDs and envelope checks',()=>{
  const p={id:'p',number:'P1',containerNo:'C1',cartonIds:['a:1','a:2'],l:1000,w:1200,h:1000,tareKg:'',extraKg:'',maxGrossKg:1};
  const r=calculateShipment(draft({pallets:[p]}));
  assert.equal(r.ready,true); assert.equal(r.totalGrossKg,26.833);assert.equal(r.pallets[0].grossKg,24);
  assert.equal(r.totalCbm,1.2+.06384);
  assert.equal(calculateShipment(draft({pallets:[p,{...p,id:'p2',number:'P2'}]})).ready,false);
});
test('legacy confirmed snapshots keep original weight convention',()=>{
  const old=draft({weightBasis:undefined,lines:[line({netKg:10,tailGrossKg:3,tailNetKg:2})]});
  const record=confirmShipment(old,'2026-09-05T00:00:00Z');
  assert.equal(calculateShipment(record).totalGrossKg,27);
  assert.equal(calculateShipment(record).totalNetKg,22);
  assert.equal(calculateShipment({...record,weightBasis:CARTON_WEIGHT_BASIS}).totalGrossKg,26.833);
  assert.equal(record.weightBasis,undefined);
});
test('planner per-container and shipment totals agree after splitting a SKU across containers',()=>{
  const item={id:'a',code:'A',productQuantity:27100,eaPerBox:600,carton:{l:480,w:380,h:350},packaging:'carton',grossKg:7.123};
  const r=planMixedContainers([item],{l:2000,w:1500,h:1500,doorW:1450,doorH:1400});
  assert.ok(r.containers.length>1); assert.equal(r.plannedBoxes,46);
  const mass=auditPlanMass(r), expected=cartonBatchMass(item.productQuantity,item.eaPerBox,item.grossKg);
  assert.equal(mass.totalGrossKg,expected.grossKg);assert.equal(mass.totalNetKg,expected.netKg);
});
test('whole-line mass and per-carton shipment rounding are identical for many remainders',()=>{
  for(let quantity=1;quantity<1600;quantity+=17){
    const r=calculateShipment(draft({lines:[line({quantity,grossKg:7.123})]}));
    const mass=cartonBatchMass(quantity,600,7.123);
    assert.equal(r.totalGrossKg,mass.grossKg);assert.equal(r.totalNetKg,mass.netKg);
  }
});
