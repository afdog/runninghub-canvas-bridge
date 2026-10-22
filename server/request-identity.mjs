import {createHash,randomUUID} from 'node:crypto';
export function browserRequestId(input) {
  if (!input.requestId) return randomUUID(); // Compatibility with older clients.
  if (!/^[\w-]{8,128}$/.test(input.requestId)) throw Error('REQUEST_ID_REQUIRED');
  const key=input.action==='manageCanvas' ? (input.origin || 'https://rhtv.runninghub.ai')+':'+input.requestId : input.action+':'+input.requestId;
  return createHash('sha256').update(key).digest('hex');
}
