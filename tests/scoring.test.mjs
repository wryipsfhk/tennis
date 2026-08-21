import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

async function scoringRules(){
  const source=await readFile(new URL('../scoring.js',import.meta.url),'utf8'),context={};
  context.globalThis=context;vm.runInNewContext(source,context);
  return context.AcePointScoring;
}

test('standard tennis validation remains unchanged',async()=>{
  const rules=await scoringRules();
  const result=rules.validateStandardSets([
    {index:0,player:'6',opponent:'4',hasTb:false,tbPlayer:'',tbOpponent:''},
    {index:1,player:'7',opponent:'6',hasTb:true,tbPlayer:'7',tbOpponent:'5'},
    {index:2,player:'',opponent:'',hasTb:false,tbPlayer:'',tbOpponent:''}
  ]);
  assert.equal(result.ok,true);assert.equal(result.scoreFormat,'standard');assert.equal(result.won,2);assert.equal(result.lost,0);
});

test('custom 7-point and 10-point games produce normal win/loss totals',async()=>{
  const rules=await scoringRules();
  const seven=rules.validateCustomPoints({player:'7',opponent:'5',target:'7',winBy:'2'});
  const ten=rules.validateCustomPoints({player:'8',opponent:'10',target:'10',winBy:'2'});
  assert.equal(seven.ok,true);assert.equal(seven.won,1);assert.equal(seven.lost,0);assert.deepEqual({...seven.customScoring},{target:7,winBy:2});
  assert.equal(ten.ok,true);assert.equal(ten.won,0);assert.equal(ten.lost,1);assert.deepEqual({...ten.customScoring},{target:10,winBy:2});
});

test('custom points enforce the chosen target and lead',async()=>{
  const rules=await scoringRules();
  assert.match(rules.validateCustomPoints({player:'6',opponent:'5',target:'7',winBy:'1'}).error,/at least 7/);
  assert.match(rules.validateCustomPoints({player:'10',opponent:'9',target:'10',winBy:'2'}).error,/lead by at least 2/);
  assert.equal(rules.validateCustomPoints({player:'12',opponent:'10',target:'10',winBy:'2'}).ok,true);
});

test('win by zero allows the first player to reach the target to win',async()=>{
  const rules=await scoringRules();
  const result=rules.validateCustomPoints({player:'7',opponent:'6',target:'7',winBy:'0'});
  assert.equal(result.ok,true);assert.equal(result.won,1);assert.deepEqual({...result.customScoring},{target:7,winBy:0});
  assert.match(rules.validateCustomPoints({player:'6',opponent:'5',target:'7',winBy:'0'}).error,/at least 7/);
  assert.match(rules.validateCustomPoints({player:'7',opponent:'7',target:'7',winBy:'0'}).error,/cannot end in a tie/);
});
