import {failurePolicy} from './failure-policy.mjs';
export function toolGuidance(result,{name,args={}}={}){
 if(result?.ok!==false)return result;
 if(!result.errorCode&&result.result?.errorCode)result={...result,errorCode:result.result.errorCode};
 const policy=failurePolicy(result),canvasUrl=result.canvasUrl||args.canvasUrl,requestId=result.requestId||args.requestId;
 const recovery={action:policy.action,retryable:policy.retryable,stopRepeating:true};
 if(policy.code==='CANVAS_CONNECTION_PENDING'){recovery.action='wait_for_page_connection';recovery.tool='rh_status';recovery.arguments={};recovery.retryAfterMs=2000;recovery.maxAttempts=5;}
 else if(result.browserRequestId){recovery.action='recover_receipt';recovery.tool='rh_browser_result';recovery.arguments={browserRequestId:result.browserRequestId};}
 else if(policy.category==='unknown' && requestId){recovery.tool='rh_command_result';recovery.arguments={requestId,...(canvasUrl?{canvasUrl}:{})};}
 else if(/APP_EXPECTATION_FAILED|APP_PREFLIGHT_FAILED/.test(policy.code)){
  const issues=result.expectationErrors||result.result?.expectationErrors||[];const schemaIssue=issues.some(i=>/AMBIGUOUS|UNKNOWN|UNSUPPORTED|INVALID|REQUIRED|DUPLICATE|CONFLICT/.test(i.code));
  recovery.action=schemaIssue?'inspect_app_fields':'reread_changed_inputs';recovery.tool=schemaIssue?'rh_app_schema':'rh_get_node';recovery.arguments={...(args.nodeId?{nodeId:args.nodeId}:{}),...(!schemaIssue?{view:'inputs'}:{}),...(args.scopeId?{scopeId:args.scopeId}:{})};if(!args.nodeId)recovery.requiresInput=['nodeId'];
 }else if(/SCOPE_EXPIRED|TASK_SCOPE_REQUIRED|READ_ONLY/.test(policy.code)){
  recovery.action='connect_exact_canvas';recovery.tool='rh_open_canvas';recovery.arguments=canvasUrl?{canvasUrl}:{};if(!canvasUrl)recovery.requiresInput=['canvasUrl'];
 }else if(/EDIT_CONFLICT|NODE_NOT_FOUND|REFERENCE.*AMBIGUOUS/.test(policy.code)){
  recovery.action='reread_changed_inputs';recovery.tool='rh_get_node';recovery.arguments={...(args.nodeId?{nodeId:args.nodeId}:{}),view:'inputs',...(args.scopeId?{scopeId:args.scopeId}:{})};if(!args.nodeId)recovery.requiresInput=['nodeId'];
 }else if(/APP_INPUT|AI_APP_NOT_CONFIGURED|APP_REUSE/.test(policy.code)){
  recovery.action='inspect_app_fields';recovery.tool='rh_app_schema';recovery.arguments={...(args.nodeId?{nodeId:args.nodeId}:{}),...(args.scopeId?{scopeId:args.scopeId}:{})};if(!args.nodeId)recovery.requiresInput=['nodeId'];
 }else if(/MODEL_TYPES_INVALID|MODEL_NOT_FOUND/.test(policy.code)){
  recovery.action='inspect_model_catalog';recovery.tool='rh_list_models';recovery.arguments={...(args.scopeId?{scopeId:args.scopeId}:{})};
 }else if(policy.category==='transient'){recovery.action='retry_read_after_delay';recovery.retryAfterMs=2000;recovery.maxAttempts=2;}
 // Recommendations never authorize generation or another mutation. Caller must change the failed precondition.
 return {...result,errorCode:policy.code,recovery};
}
