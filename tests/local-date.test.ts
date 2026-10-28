import test from 'node:test';
import assert from 'node:assert/strict';
import { localDateStamp } from '../src/main/files';
test('output filename date follows local calendar at UTC date boundary',()=>{
 const previous=process.env.TZ;
 try {process.env.TZ='Asia/Shanghai';assert.equal(localDateStamp(Date.parse('2026-10-27T20:30:00Z')),'20261028');process.env.TZ='America/Los_Angeles';assert.equal(localDateStamp(Date.parse('2026-10-28T02:30:00Z')),'20261027');assert.throws(()=>localDateStamp(NaN));}
 finally {if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
