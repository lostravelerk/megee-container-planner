import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise the real boundary parser without making network writes or mocking
// any successful packing result. The Workers binding is never called here.
const route = await readFile(new URL('../app/api/shares/route.ts', import.meta.url),'utf8');
const code = ts.transpileModule(route.replace('import { env } from "cloudflare:workers";', 'const env = {};')
  + '\nexport { sanitizePayload };', {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {sanitizePayload} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const source = () => ({containerType:'40HQ',containerCount:1,planningMode:'order',rows:[{
  id:'qa',code:'X40402',name:'QA',productQuantity:21600,eaPerBox:600,l:480,w:380,h:350,
  packaging:'pallet',palletL:1000,palletW:1200,palletH:150,palletOverhang:0,
  grossKg:12.125,tailGrossKg:'',palletTareKg:15,palletExtraKg:1.5,
  minimumQuantity:'',maximumQuantity:'',targetQuantity:''}],
  config:{cartonTolerance:3,cartonGap:5,skuGap:30,doorClearance:80,sideClearance:30,topClearance:50,
    palletCartonGap:5,palletGap:20,palletTolerance:10,edgeInset:10,palletPreset:'hq-6x1',palletLayers:6,palletStackLevels:1}});

test('sharing preserves customer policy, quantities, dimensions and exact mass inputs',()=>{
  for(const preset of ['hq-6x1','hq-3x2','gp-5x1','factory-4x1','custom','auto','hq-choice']) {
    const s=source(); s.config.palletPreset=preset;
    const before=structuredClone(s), parsed=sanitizePayload(s);
    assert.equal(parsed.config.palletPreset,preset);
    for(const key of ['productQuantity','eaPerBox','l','w','h','palletL','palletW','palletH','grossKg','palletTareKg','palletExtraKg','minimumQuantity','targetQuantity','maximumQuantity'])
      assert.equal(parsed.rows[0][key],s.rows[0][key]);
    assert.deepEqual(s,before);
  }
});

test('share endpoint rejects, never clamps or rounds, unsupported physical data',()=>{
  for(const [key,value] of [['eaPerBox',600.5],['productQuantity',21600.5],['l',20001],['h',-1],['palletH',6000],['grossKg',-1]]) {
    const s=source(); s.rows[0][key]=value; assert.throws(()=>sanitizePayload(s));
  }
  for(const [key,value] of [['palletLayers',0],['palletLayers',3.5],['palletStackLevels',3],['palletPreset','hq-typo']]) {
    const s=source(); s.config[key]=value; assert.throws(()=>sanitizePayload(s));
  }
  const s=source(); s.rows=Array.from({length:101},()=>s.rows[0]); assert.throws(()=>sanitizePayload(s),/no rows were removed/);
});
