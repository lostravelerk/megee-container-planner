import test from 'node:test';
import assert from 'node:assert/strict';
import { planMixedContainers, planMixedContainerOptions, optimizeProcurementQuantities, validateMixedPlan } from '../lib/mixedPacking.js';
import { auditPlanMass } from '../lib/planMass.js';
const c={l:2000,w:1500,h:1500,doorW:1450,doorH:1400};
const item={id:'QA',code:'QA',series:'',name:'',productQuantity:1300,eaPerBox:600,carton:{l:480,w:380,h:390},packaging:'carton',grossKg:12,tailGrossKg:3,weightSourceQuantity:1300};
test('plan carton weights use net minus 1 kg and estimated partials, excluding legacy payload and materials',()=>{
  const result=planMixedContainers([item],c);
  const audit=auditPlanMass(result,{securingKg:2,payloadKg:100});
  assert.equal(audit.verified,true); assert.equal(audit.totalGrossKg,26.833); assert.equal(audit.totalNetKg,23.833);
  assert.equal(audit.containers[0].estimatedPartial,true);
  assert.deepEqual(auditPlanMass(result,{securingKg:2,payloadKg:20}),audit);
});
test('missing weights remain unknown, changed quantities use the same standard weight rule',()=>{
  const result=planMixedContainers([{...item,productQuantity:1400}],c);
  const audit=auditPlanMass(result,{securingKg:0,payloadKg:100});
  assert.equal(audit.verified,true); assert.equal(audit.totalGrossKg,28.667); assert.equal(audit.totalNetKg,25.667);
  const missing=auditPlanMass(planMixedContainers([{...item,grossKg:''}],c));
  assert.equal(missing.verified,false); assert.equal(missing.totalGrossKg,null);
});
test('best-only mode returns the same geometry as all three presentation options',()=>{
  const a=planMixedContainerOptions([item],c),b=planMixedContainerOptions([item],c,{maximumOnly:true});
  assert.equal(a.length,3); assert.equal(b.length,1); assert.deepEqual(b[0].result,a[0].result);
});
test('time-budget result is audited or explicitly reports no candidate, never an optimality claim',()=>{
  const r=optimizeProcurementQuantities([{...item,quantityRule:'adjustable',minimumQuantity:600,maximumQuantity:100000}],c,{searchBudgetMs:.01});
  assert.equal(r.searchBudgetReached,true); assert.equal(r.optimalityProven,false);
  if(!r.error){assert.equal(validateMixedPlan(r.result).ok,true);assert.ok(r.result.totalDemandEa>0);}
});
test('legacy payload limits do not constrain procurement geometry',()=>{
  const r=optimizeProcurementQuantities([{...item,productQuantity:1200,quantityRule:'fixed'}],c,{securingKg:0,payloadKg:10});
  assert.ok(!r.error); assert.equal(validateMixedPlan(r.result).ok,true);
  assert.equal(auditPlanMass(r.result,{securingKg:0,payloadKg:10}).totalGrossKg,24);
});
