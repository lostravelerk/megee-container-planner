import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateShipment, confirmShipment, lineFromProfile } from '../lib/shipping.js';
const line = (changes = {}) => ({ id:'sku', code:'X40402', name:'Test', quantity:1300, eaPerBox:600,
  l:480, w:380, h:390, grossKg:12, netKg:10, tailGrossKg:3, tailNetKg:2, lot:'LOT-1', containerNo:'C1', ...changes });
const shipment = (changes = {}) => ({ schemaVersion:1, id:'shipment', revision:1, status:'draft', reference:'SHIP-1',
  customer:'QA', date:'2026-09-05', order:'PO1', destination:'QA', lines:[line()], pallets:[], ...changes });
test('shipment quantities and 600 EA/BOX remain exactly as entered, including measured tail', () => {
  const result = calculateShipment(shipment());
  assert.equal(result.totalQuantity,1300); assert.equal(result.cartons.length,3);
  assert.deepEqual(result.cartons.map(c=>c.quantity),[600,600,100]);
  assert.equal(result.totalGrossKg,27); assert.equal(result.totalNetKg,22);
  assert.ok(Math.abs(result.totalCbm-3*480*380*390/1e9)<1e-12); assert.equal(result.ready,true);
});
test('unknown weight never silently becomes zero or a proportional estimate', () => {
  for (const changes of [{grossKg:''},{tailGrossKg:''}]) {
    const result = calculateShipment(shipment({lines:[line(changes)]}));
    assert.equal(result.totalGrossKg,null); assert.equal(result.ready,false);
    assert.throws(()=>confirmShipment(shipment({lines:[line(changes)]})));
  }
});
test('loaded pallet CBM replaces enclosed carton CBM; tare and auxiliaries counted once', () => {
  const p={id:'p',number:'P001',containerNo:'C1',cartonIds:['sku:1','sku:2'],l:1000,w:1200,h:1000,tareKg:20,extraKg:1,maxGrossKg:100};
  const result=calculateShipment(shipment({pallets:[p]}));
  assert.equal(result.totalGrossKg,48); assert.equal(result.pallets[0].grossKg,45);
  assert.equal(result.loose.length,1); assert.equal(result.totalCbm,1.2+480*380*390/1e9);
});
test('duplicate pallet assignment and stale carton IDs block confirmation', () => {
  const p={id:'p',number:'P1',cartonIds:['sku:1'],l:1000,w:1200,h:1000,tareKg:20,extraKg:0};
  for (const pallets of [[p,{...p,id:'p2',number:'P2'}],[{...p,cartonIds:['sku:9']}],[p,{...p,id:'p2',cartonIds:['sku:2']}]]) {
    assert.equal(calculateShipment(shipment({pallets})).ready,false);
    assert.throws(()=>confirmShipment(shipment({pallets})));
  }
});
test('negative / inconsistent mass and unsafe quantities cannot confirm', () => {
  for(const changes of [{grossKg:-1},{netKg:50},{quantity:1.5},{quantity:Infinity},{eaPerBox:0},{l:0},{quantity:9007199254740992}]) {
    assert.equal(calculateShipment(shipment({lines:[line(changes)]})).ready,false);
  }
});
test('confirmed snapshot and explicitly selected profile copies remain independent', () => {
  const d=shipment(), record=confirmShipment(d,'2026-09-05T00:00:00.000Z');
  d.lines[0].eaPerBox=630;
  assert.equal(record.lines[0].eaPerBox,600);
  const profile={...line(),revision:3}, copied=lineFromProfile(profile,'new-line');
  profile.eaPerBox=99;
  assert.equal(copied.eaPerBox,600); assert.equal(copied.quantity,''); assert.equal(copied.lot,'');
  assert.equal(copied.tailGrossKg,''); assert.equal(copied.profileRevision,3);
});
test('integer conservation across many remainders and mixed SKU pallets', () => {
  for(let quantity=1;quantity<1600;quantity+=17) {
    const result=calculateShipment(shipment({lines:[line({quantity}),line({id:'b',code:'B',quantity:quantity+7,eaPerBox:53})]}));
    assert.equal(result.totalQuantity,quantity*2+7);
    assert.equal(result.cartons.length,Math.ceil(quantity/600)+Math.ceil((quantity+7)/53));
    assert.equal(new Set(result.cartons.map(c=>c.id)).size,result.cartons.length);
  }
});
test('zero auxiliary weight is explicit; absent auxiliary weight blocks release', () => {
  const p={id:'p',number:'P1',cartonIds:['sku:1'],l:1000,w:1200,h:1000,tareKg:20,extraKg:''};
  assert.equal(calculateShipment(shipment({pallets:[p]})).ready,false);
  assert.equal(calculateShipment(shipment({pallets:[{...p,extraKg:0}]})).ready,true);
});
