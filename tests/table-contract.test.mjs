import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
test('alignment contract is loaded centrally and binds numeric headers and cells together',()=>{
  assert.match(read('app/globals.css'),/@import "\.\/data-tables\.css"/);
  const css=read('app/data-tables.css');
  assert.match(css,/table\.data-table :is\(th,td\)\.numeric/);
  assert.match(css,/vertical-align: middle !important/);
  for(const table of ['mixed-entry-grid','mixed-allocation-table','report-product-master-table','mixed-report-allocation','packing-list-products','packing-list-allocation'])
    assert.ok(css.includes(`.${table} :is(thead,tbody) :is(th,td)`),table);
  assert.match(css,/display:table-header-group/);assert.match(css,/break-inside:auto !important/);
  assert.match(read('AGENTS.md'),/docs\/table-layout-contract\.md/);
});
test('pallet summary numeric header/body annotations and fixed precision stay paired',()=>{
  const source=read('app/PalletPolicySummary.tsx');
  assert.equal((source.match(/<th className="numeric"/g)||[]).length,5);
  assert.equal((source.match(/<td className="numeric"/g)||[]).length,5);
  assert.match(source,/minimumFractionDigits/);
});
test('all current input modules use a single readonly net-weight component',()=>{
  const source=read('app/StandardCartonWeights.tsx');
  assert.match(source,/readOnly tabIndex=\{-1\}/);assert.match(source,/net\.toFixed\(3\)/);
  assert.match(read('app/MixedPlanner.tsx'),/<StandardCartonWeights/);
  assert.equal(existsSync(new URL('../app/ShippingWorkspace.tsx',import.meta.url)),false);
  assert.doesNotMatch(read('app/MixedPlanner.tsx'),/className="planner-weight-inputs"/);
});
test('only planner and saved plans remain; retired modules are not hidden active components',()=>{
  const source=read('app/LoadPlanner.tsx');
  assert.match(source,/type WorkspaceView = "planner" \| "library";/);
  assert.doesNotMatch(source,/ShippingWorkspace|批次装箱单|产品包装|setView\("shipments"\)/);
  assert.doesNotMatch(source,/localStorage\.removeItem|localStorage\.clear/);
});
