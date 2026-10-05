import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Logger } from '../logger.js';
import { DshClient, type DshClientOptions } from './client.js';

/** Keyless process fixture exercising the real ACP transport rather than mocking client methods. */
export async function fakeDsh() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-dsh-test-'));
  const cliBin = path.join(root, 'fake-dsh.mjs');
  await fs.writeFile(cliBin, `
import readline from 'node:readline';
import fs from 'node:fs';
const sessionsPath = ${JSON.stringify(path.join(root, 'sessions.json'))};
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\\n');
let sessions = fs.existsSync(sessionsPath) ? JSON.parse(fs.readFileSync(sessionsPath, 'utf8')) : {};
let sequence = Object.keys(sessions).length;
const model = JSON.stringify(['fixture', 'alpha']);
const other = JSON.stringify(['fixture', 'model-'+ 'long'.repeat(30)]);
const config = id => [{id:'model',name:'Model',type:'select',currentValue:sessions[id].model,options:[{group:'fixture',name:'Fixture',options:[{value:model,name:'Alpha'},{value:other,name:'Long model'}]}]}, {id:'reasoning_effort',name:'Reasoning',type:'select',currentValue:sessions[id].effort,options:[{value:'high',name:'High'},{value:'thinking_16384',name:'Custom effort'}]}];
const running = new Map();
const approvals = new Map();
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line), p=m.params || {};
 if (!m.method && approvals.has(m.id)) {const pending=approvals.get(m.id);approvals.delete(m.id);if(running.get(pending.sessionId)!==pending.id)return;running.delete(pending.sessionId);send({method:'session/update',params:{sessionId:pending.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m.result)}}}});return send({id:pending.id,result:{stopReason:'end_turn'}});}
 if (m.method === 'initialize') return send({id:m.id,result:{protocolVersion:1,agentCapabilities:{promptCapabilities:{image:true},sessionCapabilities:{list:{},resume:{},close:{}}},authMethods:[]}});
 if (m.method === 'session/new') {const id='session-'+(++sequence);sessions[id]={cwd:p.cwd,model,effort:'high'};fs.writeFileSync(sessionsPath,JSON.stringify(sessions));return send({id:m.id,result:{sessionId:id,configOptions:config(id)}});}
 if (m.method === 'session/list') return send({id:m.id,result:{sessions:Object.entries(sessions).map(([sessionId,s])=>({sessionId,cwd:s.cwd}))}});
 if (m.method === 'session/resume') return send({id:m.id, result:{configOptions:config(p.sessionId)}});
 if (m.method === 'session/close') return send({id:m.id,result:{}});
 if (m.method === 'session/set_config_option') {sessions[p.sessionId][p.configId==='model'?'model':'effort']=p.value;if(p.configId==='model') sessions[p.sessionId].effort='high';fs.writeFileSync(sessionsPath,JSON.stringify(sessions));return send({id:m.id,result:{configOptions:config(p.sessionId)}});}
 if (m.method === 'session/cancel') {const id=running.get(p.sessionId);if(id!=null){running.delete(p.sessionId);send({id,result:{stopReason:'cancelled'}});}return;}
 if (m.method === 'session/prompt') {
  const text=p.prompt.filter(c=>c.type==='text').map(c=>c.text).join('');
  if(text==='disconnect') return process.exit(2);
  running.set(p.sessionId,m.id);
  send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'tool_call',toolCallId:'t1',title:'read_file',status:'in_progress',rawInput:{path:'test'}}}});
  if(text==='wait') return;
  if(text==='permission') {const id='approval-'+m.id;approvals.set(id,{id:m.id,sessionId:p.sessionId});return send({id,method:'session/request_permission',params:{sessionId:p.sessionId,toolCall:{toolCallId:'t1',title:'Run a command'},options:[{optionId:'native-allow',kind:'allow_once',name:'Allow once'},{optionId:'native-reject',kind:'reject_once',name:'Reject'}]}});}
  send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'PRIVATE REASONING'}}}});
  send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_message_chunk',messageId:'intermediate',content:{type:'text',text:'Working...'}}}});
  send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'tool_call_update',toolCallId:'t1',status:'completed'}}});
  send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_message_chunk',messageId:'final',content:{type:'text',text:JSON.stringify({text,model:sessions[p.sessionId].model,effort:sessions[p.sessionId].effort,images:p.prompt.filter(c=>c.type==='image').length})}}}});
  running.delete(p.sessionId);send({id:m.id,result:{stopReason:'end_turn'}});
 }
});
process.stdin.on('end',()=>process.exit(0));
`);
  const options: DshClientOptions = { cliBin, profile: 'acp', patches: [], home: path.join(root, '.dsh'), runtimeDir: path.join(root, 'runtime'), startupTimeoutMs: 2000 };
  const logger = new Logger('error', path.join(root, 'test.log'));
  return { root, options, createClient: (scopeId: string) => new DshClient(options, scopeId, logger), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
