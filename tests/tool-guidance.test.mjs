import test from 'node:test';import assert from 'node:assert/strict';import {toolGuidance} from '../server/tool-guidance.mjs';
test('unknown generation points only at the original receipt and never suggests a replacement run',()=>{
 const r=toolGuidance({ok:false,errorCode:'COMMAND_OUTCOME_UNKNOWN',submissionState:'unknown',requestId:'original'},{name:'rh_run_node',args:{nodeId:'n'}});
 assert.equal(r.recovery.tool,'rh_command_result');assert.equal(r.recovery.arguments.requestId,'original');assert.equal(r.recovery.retryable,false);assert.equal(r.recovery.stopRepeating,true);
});
test('missing scope guidance requests a known target rather than inventing canvas identity',()=>{
 const r=toolGuidance({ok:false,error:'TASK_SCOPE_REQUIRED'},{args:{nodeId:'n'}});assert.equal(r.errorCode,'TASK_SCOPE_REQUIRED');assert.equal(r.recovery.tool,'rh_open_canvas');assert.deepEqual(r.recovery.requiresInput,['canvasUrl']);assert.deepEqual(r.recovery.arguments,{});
});
test('app and permanent history failures have distinct recovery actions',()=>{
 const app=toolGuidance({ok:false,error:'APP_INPUT_UNKNOWN: field'},{args:{nodeId:'n',scopeId:'scope'}});assert.equal(app.recovery.tool,'rh_app_schema');assert.equal(app.recovery.arguments.nodeId,'n');
 const history=toolGuidance({ok:false,errorCode:'COMMAND_FAILED',error:'Error: HISTORY_EMBEDDED_ENTRY_CONFLICT'});assert.equal(history.errorCode,'HISTORY_EMBEDDED_ENTRY_CONFLICT');assert.equal(history.recovery.retryable,false);assert.equal(history.recovery.tool,undefined);
});
