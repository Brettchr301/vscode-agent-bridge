/**
 * VS Code Agent Bridge  v3.4  Advanced Automation
 * HTTP server on :3131 giving agents full VS Code + Copilot access.
 *
 * ENDPOINTS
 *   GET  /health
 *   GET  /workspace-info
 *   GET  /read-file?path=<p>
 *   GET  /list-dir?path=<p>
 *   GET  /diagnostics?path=<p>      errors + warnings
 *   GET  /changes-since?ts=<ms>
 *   GET  /pending-approvals
 *   GET  /watch-result?id=<id>
 *   POST /prompt                    { prompt, model?, system?, timeout?, context_files?: string[] }
 *   POST /copilot-task              { prompt, auto_accept?, watch_secs?, timeout? }
 *   POST /write-file                { path, content, create_dirs? }
 *   POST /apply-edit                { path, old_text, new_text }
 *   POST /run-terminal              { command, cwd? }
 *   POST /open-file                 { path, line? }
 *   POST /watch-start               { label? }
 *   POST /accept-edits
 *   POST /reject-edits
 *   POST /keep-going                clicks any "Continue / Keep / Accept / Allow" dialog\n *   POST /auto-dismiss              { active: true|false, interval_ms? }  background loop\n *   GET  /auto-dismiss              current loop status
 *   POST /save-all
 *   POST /exec-command              { command, args? }
 *   POST /show-message              { message, level? }
 *   POST /insert-text               { text, path?, line?, column? }
 *   POST /slack-post                { text, channel? }  -- posts to Slack via stored bot token
 *   POST /desktop-type              { app, text, window_title?, delay_ms? } -- WScript.Shell SendKeys
 */
import * as vscode from 'vscode';
import * as http   from 'http';
import * as https  from 'https';
import * as fs     from 'fs';
import * as np     from 'path';
import * as os     from 'os';
import { exec }    from 'child_process';

const PORT_START  = 3131;
const LOG_DIR     = process.env.APPDATA ? np.join(process.env.APPDATA,'AgentBridge') : '/tmp';
const LOG_FILE    = np.join(LOG_DIR,'requests.log');
const MAX_LOG     = 500;

let srv: http.Server|null       = null;
let bar: vscode.StatusBarItem;
let port          = PORT_START;
let logPanel: vscode.WebviewPanel|null = null;
const logEntries: string[]      = [];

// Auto-dismiss: polls every N ms and clicks Allow/Continue/Keep/Accept dialogs
let autoDismissTimer: NodeJS.Timeout|null = null;

function startAutoDismiss(intervalMs = 1500){
  if(autoDismissTimer) return;  // already running
  autoDismissTimer = setInterval(async ()=>{
    try{ await tryCmds(KEEP_GOING_CMDS); }catch{}
    // Also try to press Enter / click focused button in any notification
    try{ await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); }catch{}
  }, intervalMs);
}

function stopAutoDismiss(){
  if(autoDismissTimer){ clearInterval(autoDismissTimer); autoDismissTimer=null; }
}

//  change tracker 
interface CE { path:string; ts:number }
const chlog:CE[]                = [];
const sessions = new Map<string,{startTs:number;label:string}>();
const regChange = (u:vscode.Uri) => {
  if(u.scheme!=='file') return;
  chlog.push({path:u.fsPath,ts:Date.now()});
  if(chlog.length>MAX_LOG) chlog.shift();
};
const uniq = (l:CE[]) => [...new Set(l.map(c=>c.path))];

//  helpers 
const body = (req:http.IncomingMessage):Promise<Record<string,unknown>> =>
  new Promise(ok=>{let s='';req.on('data',c=>s+=c);req.on('end',()=>{try{ok(JSON.parse(s||'{}'))}catch{ok({})}});req.on('error',()=>ok({}))});

const qs = (url:string):Record<string,string> => {
  const i=url.indexOf('?');
  return i<0?{}:Object.fromEntries(new URLSearchParams(url.slice(i+1)));
};

const send = (res:http.ServerResponse,status:number,data:unknown) => {
  const j=JSON.stringify(data);
  res.writeHead(status,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'});
  res.end(j);
};

const log = (method:string,path:string,req:unknown,resp:unknown) => {
  const line = `[${new Date().toISOString()}] ${method} ${path}  req=${JSON.stringify(req).slice(0,200)}  resp=${JSON.stringify(resp).slice(0,200)}`;
  logEntries.push(line);
  if(logEntries.length>200) logEntries.shift();
  if(logPanel) logPanel.webview.postMessage({type:'log',line});
  try{
    if(!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR,{recursive:true});
    fs.appendFileSync(LOG_FILE,line+'\n');
  }catch{}
};

const readText = async (p:string) => {
  try{ return (await vscode.workspace.openTextDocument(vscode.Uri.file(p))).getText(); }
  catch{ return fs.readFileSync(p,'utf-8'); }
};

const mkdirFor = (p:string) => { try{ fs.mkdirSync(np.dirname(p),{recursive:true}); }catch{} };

//  copilot call 
const preferOrder = [
  'claude-sonnet-4-5','claude-sonnet-4','gpt-4.1','gpt-4o',
  'gpt-5','claude-opus-4','gpt-4','gpt-3.5-turbo'
];

async function callCopilot(prompt:string,system?:string,pref?:string,ms=300000){
  const order = pref?[pref,...preferOrder]:preferOrder;
  let model:vscode.LanguageModelChat|undefined;
  for(const f of order){
    const c = await vscode.lm.selectChatModels({vendor:'copilot',family:f});
    if(c.length){model=c[0];break;}
  }
  if(!model){
    const all = await vscode.lm.selectChatModels({vendor:'copilot'});
    if(!all.length) throw new Error('No Copilot model  sign in to GitHub Copilot');
    model = all[0];
  }
  const msgs:vscode.LanguageModelChatMessage[] = [];
  if(system) msgs.push(vscode.LanguageModelChatMessage.Assistant(system));
  msgs.push(vscode.LanguageModelChatMessage.User(prompt));
  const cts = new vscode.CancellationTokenSource();
  const t = setTimeout(()=>cts.cancel(),ms);
  try{
    const r = await model.sendRequest(msgs,{},cts.token);
    let text='';
    for await(const c of r.text) text+=c;
    return {text,model_used:model.name};
  }finally{clearTimeout(t);cts.dispose();}
}

//  accept / reject 
const ACCEPT = ['workbench.action.chat.acceptAllCopilotEdits','inlineChat.acceptChanges','editor.action.inlineSuggest.accept','copilot.chat.acceptEdits'];
const REJECT = ['workbench.action.chat.discardAllCopilotEdits','inlineChat.discard','editor.action.inlineSuggest.hide'];
const DISMISS = ['workbench.action.closeMessages','notifications.clearAll','editor.action.inlineSuggest.accept','workbench.action.acceptSelectedQuickOpenItem'];
const KEEP_GOING_CMDS = [...ACCEPT,...DISMISS,'workbench.action.closeNotification'];

const tryCmds = async (cmds:string[]) => {
  const ran:string[]=[];
  for(const c of cmds){ try{await vscode.commands.executeCommand(c);ran.push(c);}catch{} }
  return ran;
};

//  apply workspace edit 
async function applyEdit(path:string,oldText:string,newText:string){
  const uri  = vscode.Uri.file(path);
  const doc  = await vscode.workspace.openTextDocument(uri);
  const full = doc.getText();
  const idx  = full.indexOf(oldText);
  if(idx<0) throw new Error(`old_text not found in ${path}`);
  const edit = new vscode.WorkspaceEdit();
  const start = doc.positionAt(idx);
  const end   = doc.positionAt(idx+oldText.length);
  edit.replace(uri,new vscode.Range(start,end),newText);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
}

//  terminal + wait 
function runShellAndCapture(cmd:string,cwd:string,timeoutMs:number):Promise<{stdout:string;stderr:string;code:number}>{
  return new Promise(ok=>{
    exec(cmd,{cwd:cwd||undefined,timeout:timeoutMs,windowsHide:true},(err,stdout,stderr)=>{
      ok({stdout:stdout||'',stderr:stderr||'',code:err?.code??0});
    });
  });
}

//  router 
async function route(req:http.IncomingMessage, res:http.ServerResponse){
  const raw   = req.url??'/';
  const path  = raw.split('?')[0];
  const qp    = qs(raw);
  const meth  = req.method??'GET';

  if(meth==='OPTIONS'){send(res,200,{});return;}

  // Optional auth: if agentBridge.authToken is set (VS Code settings or ~/.agent-bridge/config.json), all requests except /health must supply it
  const cfgAuth = (()=>{
    let t = vscode.workspace.getConfiguration('agentBridge').get<string>('authToken','');
    if(!t){
      try{
        const localCfg=JSON.parse(fs.readFileSync(np.join(os.homedir(),'.agent-bridge','config.json'),'utf-8'));
        t=localCfg.auth_token??'';
      }catch{}
    }
    return t;
  })();
  if(cfgAuth && path!=='/health'){
    const authHeader = (req.headers['authorization']??'').replace(/^Bearer\s+/i,'');
    if(authHeader!==cfgAuth){
      send(res,401,{ok:false,error:'Unauthorized: missing or invalid Authorization: Bearer <token>'});
      return;
    }
  }

  if(meth==='GET'&&path==='/health'){
    const models = await vscode.lm.selectChatModels({vendor:'copilot'});
    send(res,200,{ok:true,port,
      models:models.map(m=>m.name),
      workspace:vscode.workspace.workspaceFolders?.[0]?.uri.fsPath??null,
      version:'3.4',
    });
    return;
  }

  //  GET /workspace-info 
  if(meth==='GET'&&path==='/workspace-info'){
    const ed = vscode.window.activeTextEditor;
    send(res,200,{ok:true,
      folders:vscode.workspace.workspaceFolders?.map(f=>f.uri.fsPath)??[],
      active_file:ed?.document.uri.fsPath??null,
      language:ed?.document.languageId??null,
      selection:ed?{start:ed.selection.start.line,end:ed.selection.end.line}:null,
      open_files:vscode.workspace.textDocuments.filter(d=>d.uri.scheme==='file').map(d=>d.uri.fsPath),
    });
    return;
  }

  //  GET /read-file 
  if(meth==='GET'&&path==='/read-file'){
    const fp = decodeURIComponent(qp.path??'');
    if(!fp){send(res,400,{ok:false,error:'path required'});return;}
    try{
      const content = await readText(fp);
      send(res,200,{ok:true,path:fp,content,lines:content.split('\n').length});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  GET /list-dir 
  if(meth==='GET'&&path==='/list-dir'){
    const dp = decodeURIComponent(qp.path??'');
    if(!dp){send(res,400,{ok:false,error:'path required'});return;}
    try{
      const entries = fs.readdirSync(dp,{withFileTypes:true});
      const items = entries.map(e=>({name:e.name,type:e.isDirectory()?'dir':'file',path:np.join(dp,e.name)}));
      send(res,200,{ok:true,path:dp,items,count:items.length});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  GET /diagnostics 
  if(meth==='GET'&&path==='/diagnostics'){
    const fp = qp.path?vscode.Uri.file(decodeURIComponent(qp.path)):undefined;
    const diags = fp
      ? vscode.languages.getDiagnostics(fp)
      : vscode.languages.getDiagnostics().flatMap(([,d])=>d);
    const items = (Array.isArray(diags)?diags:diags).map((d:vscode.Diagnostic)=>({
      severity:['Error','Warning','Info','Hint'][d.severity]??'Unknown',
      message:d.message,
      range:{start:d.range.start.line,end:d.range.end.line},
      source:d.source,
    }));
    send(res,200,{ok:true,count:items.length,items});
    return;
  }

  //  GET /changes-since 
  if(meth==='GET'&&path==='/changes-since'){
    const since=parseInt(qp.ts??'0',10);
    const files=uniq(chlog.filter(c=>c.ts>since));
    send(res,200,{ok:true,since,files,count:files.length});
    return;
  }

  //  GET /pending-approvals 
  if(meth==='GET'&&path==='/pending-approvals'){
    const dirty = vscode.workspace.textDocuments
      .filter(d=>d.isDirty&&d.uri.scheme==='file')
      .map(d=>({path:d.uri.fsPath,lang:d.languageId}));
    send(res,200,{ok:true,count:dirty.length,dirty_docs:dirty});
    return;
  }

  //  GET /watch-result 
  if(meth==='GET'&&path==='/watch-result'){
    const sess=sessions.get(qp.id??'');
    if(!sess){send(res,404,{ok:false,error:'watch_id not found'});return;}
    const files=uniq(chlog.filter(c=>c.ts>sess.startTs));
    const previews=await Promise.all(files.slice(0,10).map(async f=>{
      try{const t=await readText(f);return{path:f,lines:t.split('\n').length};}
      catch{return{path:f,lines:-1};}
    }));
    send(res,200,{ok:true,watch_id:qp.id,files_changed:files,diff_summary:previews});
    return;
  }

  //  body-required routes 
  const b = await body(req);

  //  POST /watch-start 
  if(meth==='POST'&&path==='/watch-start'){
    const id=`w_${Date.now()}`;
    sessions.set(id,{startTs:Date.now(),label:String(b.label??'')});
    send(res,200,{ok:true,watch_id:id,started_ts:Date.now()});
    return;
  }

  //  POST /accept-edits 
  if(meth==='POST'&&path==='/accept-edits'){
    const ran=await tryCmds(ACCEPT);
    await vscode.workspace.saveAll(false);
    send(res,200,{ok:true,commands_run:ran});
    return;
  }

  //  POST /reject-edits 
  if(meth==='POST'&&path==='/reject-edits'){
    const ran=await tryCmds(REJECT);
    send(res,200,{ok:true,commands_run:ran});
    return;
  }

  //  POST /keep-going 
  // Simulates a user clicking "Continue", "Keep", "Accept", dismissing modals
  if(meth==='POST'&&path==='/keep-going'){
    const ran=await tryCmds(KEEP_GOING_CMDS);
    await vscode.workspace.saveAll(false);
    try{await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');}catch{}
    send(res,200,{ok:true,commands_run:ran,note:'Dismissed dialogs + saved all'});
    return;
  }

  //  POST /auto-dismiss  — start or stop the background button-poker loop
  //  Body: { active: true|false, interval_ms?: number (default 1500) }
  if(meth==='POST'&&path==='/auto-dismiss'){
    const active = b.active!==false && b.active!=='false';
    const intervalMs = Number(b.interval_ms??1500);
    if(active){
      startAutoDismiss(intervalMs);
      send(res,200,{ok:true,active:true,interval_ms:intervalMs,note:'Auto-dismiss loop started — will click Allow/Continue/Keep every '+intervalMs+'ms'});
    } else {
      stopAutoDismiss();
      send(res,200,{ok:true,active:false,note:'Auto-dismiss loop stopped'});
    }
    return;
  }

  //  GET /auto-dismiss  — check current status
  if(meth==='GET'&&path==='/auto-dismiss'){
    send(res,200,{ok:true,active:autoDismissTimer!==null});
    return;
  }

  //  POST /save-all 
  if(meth==='POST'&&path==='/save-all'){
    await vscode.workspace.saveAll(false);
    send(res,200,{ok:true});
    return;
  }

  //  POST /prompt 
  if(meth==='POST'&&path==='/prompt'){
    const p=String(b.prompt??'').trim();
    if(!p){send(res,400,{ok:false,error:'prompt required'});return;}
    const t0=Date.now();
    try{
      // Inject context_files content into prompt
      const ctxPaths:string[] = Array.isArray(b.context_files)?(b.context_files as string[]):[];
      if((b.active_file_context===true||b.active_file_context==='true') && vscode.window.activeTextEditor)
        ctxPaths.unshift(vscode.window.activeTextEditor.document.uri.fsPath);
      let fullPrompt = p;
      if(ctxPaths.length>0){
        const blocks:string[]=[];
        for(const cf of ctxPaths.slice(0,8)){
          try{
            const txt = await readText(cf);
            blocks.push(`FILE: ${cf}\n${'`'.repeat(3)}\n${txt.slice(0,12000)}\n${'`'.repeat(3)}`);
          }catch{blocks.push(`FILE: ${cf}\n[could not read]`);}
        }
        fullPrompt = blocks.join('\n\n')+'\n\n---\n'+p;
      }
      const r=await callCopilot(fullPrompt,b.system as string|undefined,b.model as string|undefined,Number(b.timeout??300)*1000);
      const out={ok:true,...r,elapsed_ms:Date.now()-t0,context_files_injected:ctxPaths.length};
      log('POST','/prompt',{prompt:p.slice(0,100)},out);
      send(res,200,out);
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /copilot-task 
  if(meth==='POST'&&path==='/copilot-task'){
    const p=String(b.prompt??'').trim();
    if(!p){send(res,400,{ok:false,error:'prompt required'});return;}
    const autoAccept = b.auto_accept!==false;
    const watchMs    = Math.min(Number(b.watch_secs??60),300)*1000;
    const timeoutMs  = Number(b.timeout??300)*1000;
    const t0         = Date.now();
    const startTs    = t0;
    const watchId    = `w_${t0}`;
    sessions.set(watchId,{startTs,label:p.slice(0,80)});

    // Inject context_files
    const ctxPaths:string[] = Array.isArray(b.context_files)?(b.context_files as string[]):[];
    if(b.active_file_context && vscode.window.activeTextEditor)
      ctxPaths.unshift(vscode.window.activeTextEditor.document.uri.fsPath);
    let fullPrompt = p;
    if(ctxPaths.length>0){
      const blocks:string[]=[];
      for(const cf of ctxPaths.slice(0,8)){
        try{const txt=await readText(cf);blocks.push(`FILE: ${cf}\n${'`'.repeat(3)}\n${txt.slice(0,12000)}\n${'`'.repeat(3)}`);}
        catch{blocks.push(`FILE: ${cf}\n[could not read]`);}
      }
      fullPrompt = blocks.join('\n\n')+'\n\n---\n'+p;
    }

    let llm_response='', model_used='';
    // Start auto-dismiss loop so Allow/Continue/Keep buttons get clicked in real-time
    if(autoAccept) startAutoDismiss(1200);
    try{
      const r=await callCopilot(fullPrompt,b.system as string|undefined,b.model as string|undefined,timeoutMs);
      llm_response=r.text; model_used=r.model_used;
    }catch(e){
      if(autoAccept) stopAutoDismiss();
      send(res,500,{ok:false,error:`Copilot call failed: ${e}`});return;
    }

    // Keep poking buttons during the watch window too
    await new Promise(r=>setTimeout(r,watchMs));
    if(autoAccept) stopAutoDismiss();

    const changedFiles=uniq(chlog.filter(c=>c.ts>startTs));
    let accepted=false;
    if(autoAccept){
      await tryCmds(ACCEPT);
      await vscode.workspace.saveAll(false);
      accepted=true;
    }
    const diff_summary=await Promise.all(changedFiles.slice(0,10).map(async f=>{try{const t=await readText(f);return{path:f,lines:t.split('\n').length,preview:t.slice(0,6000)};}catch{return{path:f,lines:-1,preview:''};}}));
    const out={ok:true,watch_id:watchId,llm_response,model_used,files_changed:changedFiles,diff_summary,accepted,context_files_injected:ctxPaths.length,elapsed_ms:Date.now()-t0};
    log('POST','/copilot-task',{prompt:p.slice(0,100)},{files:changedFiles.length,model:model_used});
    send(res,200,out);
    return;
  }

  //  POST /write-file 
  if(meth==='POST'&&path==='/write-file'){
    const fp=String(b.path??'').trim();
    const content=String(b.content??'');
    if(!fp){send(res,400,{ok:false,error:'path required'});return;}
    try{
      if(b.create_dirs!==false) mkdirFor(fp);
      fs.writeFileSync(fp,content,'utf-8');
      // Refresh in VS Code editor if open
      const uri=vscode.Uri.file(fp);
      try{ await vscode.workspace.openTextDocument(uri); }catch{}
      send(res,200,{ok:true,path:fp,bytes:Buffer.byteLength(content)});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /apply-edit 
  if(meth==='POST'&&path==='/apply-edit'){
    const fp=String(b.path??'').trim();
    const ot=String(b.old_text??'');
    const nt=String(b.new_text??'');
    if(!fp||!ot){send(res,400,{ok:false,error:'path and old_text required'});return;}
    try{
      await applyEdit(fp,ot,nt);
      send(res,200,{ok:true,path:fp});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /insert-text 
  if(meth==='POST'&&path==='/insert-text'){
    const text=String(b.text??'');
    const fp=b.path?String(b.path):null;
    try{
      if(fp){
        const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc);
      }
      const ed=vscode.window.activeTextEditor;
      if(!ed){send(res,400,{ok:false,error:'No active editor'});return;}
      let pos=ed.selection.active;
      if(typeof b.line==='number'){
        pos=new vscode.Position(Math.max(0,(b.line as number)-1),typeof b.column==='number'?(b.column as number):0);
      }
      const edit=new vscode.WorkspaceEdit();
      edit.insert(ed.document.uri,pos,text);
      await vscode.workspace.applyEdit(edit);
      await ed.document.save();
      send(res,200,{ok:true,inserted_at:{line:pos.line,col:pos.character}});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /run-terminal 
  if(meth==='POST'&&path==='/run-terminal'){
    const cmd=String(b.command??'').trim();
    if(!cmd){send(res,400,{ok:false,error:'command required'});return;}
    // Option A: capture output via child_process (no visible terminal)
    if(b.capture_output===true){
      try{
        const r=await runShellAndCapture(cmd,String(b.cwd??''),Number(b.timeout??120)*1000);
        send(res,200,{ok:true,stdout:r.stdout.slice(0,8000),stderr:r.stderr.slice(0,2000),exit_code:r.code});
      }catch(e){send(res,500,{ok:false,error:String(e)});}
      return;
    }
    // Option B: visible VS Code terminal
    const name=`Agent-${Date.now()}`;
    const term=vscode.window.createTerminal({name,cwd:b.cwd?vscode.Uri.file(String(b.cwd)):undefined});
    term.sendText(cmd);
    term.show();
    send(res,200,{ok:true,terminal_name:name});
    return;
  }

  //  POST /open-file 
  if(meth==='POST'&&path==='/open-file'){
    const fp=String(b.path??'').trim();
    if(!fp){send(res,400,{ok:false,error:'path required'});return;}
    try{
      const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
      const opts:vscode.TextDocumentShowOptions={};
      if(typeof b.line==='number'){
        const pos=new vscode.Position(Math.max(0,(b.line as number)-1),0);
        opts.selection=new vscode.Range(pos,pos);
      }
      await vscode.window.showTextDocument(doc,opts);
      send(res,200,{ok:true,lines:doc.lineCount});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /exec-command 
  if(meth==='POST'&&path==='/exec-command'){
    const cmd=String(b.command??'').trim();
    if(!cmd){send(res,400,{ok:false,error:'command required'});return;}
    try{
      const args=Array.isArray(b.args)?b.args:[];
      const result=await vscode.commands.executeCommand(cmd,...args);
      send(res,200,{ok:true,result:result??null});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /show-message 
  if(meth==='POST'&&path==='/show-message'){
    const msg=String(b.message??'').trim();
    const lvl=String(b.level??'info');
    if(lvl==='error')      vscode.window.showErrorMessage(`Agent: ${msg}`);
    else if(lvl==='warn')  vscode.window.showWarningMessage(`Agent: ${msg}`);
    else                   vscode.window.showInformationMessage(`Agent: ${msg}`);
    send(res,200,{ok:true});
    return;
  }

  //  POST /slack-post  — post a message to Slack using stored bot token
  if(meth==='POST'&&path==='/slack-post'){
    const text=String(b.text??b.message??'').trim();
    if(!text){send(res,400,{ok:false,error:'text required'});return;}
    try{
      // Read token from deepseek_agent settings
      // Read Slack config: first try VS Code settings, then fall back to a settings.json file
      const cfg = vscode.workspace.getConfiguration('agentBridge');
      let slackToken:string = cfg.get<string>('slackBotToken','');
      let slackChannel:string = String(b.channel??cfg.get<string>('slackChannel',''));
      // Fallback: load from a settings.json sidecar if VS Code settings not configured
      if(!slackToken){
        // Standard per-user config: ~/.agent-bridge/config.json
        // Each user creates this file with their own keys — nothing is shared or hardcoded
        const sidecars = [
          np.join(os.homedir(), '.agent-bridge', 'config.json'),          // standard location
          np.join(os.homedir(), 'Documents', 'DeepBrainChat', 'settings.json'), // legacy fallback
        ];
        for(const sidecar of sidecars){
          try{
            // Strip UTF-8 BOM if present before parsing
            let raw = fs.readFileSync(sidecar,'utf-8');
            if(raw.charCodeAt(0)===0xFEFF) raw=raw.slice(1);
            const sidecarData = JSON.parse(raw);
            if(sidecarData.slack_bot_token){ slackToken = sidecarData.slack_bot_token; }
            if(!slackChannel && sidecarData.slack_channel){ slackChannel = sidecarData.slack_channel; }
            // Also load authToken from config if not set in VS Code settings
            if(!cfgAuth && sidecarData.auth_token) {
              // stored for reference but can't retroactively auth here — handled at route entry
            }
            if(slackToken) break;
          }catch{}
        }
      }
      if(!slackToken||slackToken.startsWith('xoxb-PASTE')){
        send(res,500,{ok:false,error:'Slack token not configured. Set agentBridge.slackBotToken in VS Code settings, or create ~/Documents/agent-bridge-config/settings.json with {"slack_bot_token":"xoxb-...","slack_channel":"C0..."}'}); return;
      }
      const payload=JSON.stringify({channel:slackChannel,text,unfurl_links:false});
      await new Promise<void>((resolve,reject)=>{
        const req2=https.request(
          {hostname:'slack.com',path:'/api/chat.postMessage',method:'POST',
           headers:{'Content-Type':'application/json','Authorization':`Bearer ${slackToken}`}},
          r=>{
            let d=''; r.on('data',c=>d+=c);
            r.on('end',()=>{
              try{const j=JSON.parse(d); if(j.ok)resolve(); else reject(new Error(j.error));}
              catch(e){reject(e);}
            });
          }
        );
        req2.on('error',reject);
        req2.write(payload); req2.end();
      });
      send(res,200,{ok:true,channel:slackChannel});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /desktop-type  — open an app and type text using WScript.Shell (reliable, no deps)
  if(meth==='POST'&&path==='/desktop-type'){
    const appName=String(b.app??'notepad.exe');
    const textToType=String(b.text??'');
    const windowTitle=String(b.window_title??'');
    const delayMs=Number(b.delay_ms??2000);
    // Build PowerShell script: open app, wait, WScript.Shell SendKeys
    const ps=[
      `Start-Process "${appName}"`,
      `Start-Sleep -Milliseconds ${delayMs}`,
      `$sh = New-Object -ComObject WScript.Shell`,
      windowTitle ? `$sh.AppActivate("${windowTitle.replace(/"/g,'`"')}")` : `$sh.AppActivate("${appName.replace('.exe','')}")`,
      `Start-Sleep -Milliseconds 400`,
      `$sh.SendKeys("${textToType.replace(/[+^%~(){}]/g,'{$&}').replace(/"/g,'`"')}")`
    ].join("\n");
    await new Promise<void>((resolve)=>{
      exec(`powershell -NoProfile -Command "${ps.replace(/"/g,'\\"')}"`,
        (_err,_stdout,_stderr)=>{ resolve(); });
    });
    send(res,200,{ok:true,app:appName,typed:textToType});
    return;
  }

  //  GET /log 
  if(meth==='GET'&&path==='/log'){
    send(res,200,{ok:true,entries:logEntries.slice(-100)});
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  //  ADVANCED AGENT AUTOMATION ENDPOINTS
  // ─────────────────────────────────────────────────────────────────

  //  GET /git-status  — branch, last commit, staged/unstaged counts
  if(meth==='GET'&&path==='/git-status'){
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath??process.cwd();
    try{
      const [branch,log,status] = await Promise.all([
        runShellAndCapture('git branch --show-current',cwd,8000),
        runShellAndCapture('git log -1 --format="%H|%s|%ar|%an"',cwd,8000),
        runShellAndCapture('git status --porcelain',cwd,8000),
      ]);
      const lines = status.stdout.trim().split('\n').filter(Boolean);
      const uncommitted = lines.length;
      const staged   = lines.filter(l=>!'? '.includes(l[0])).length;
      const [hash,subject,when,author] = (log.stdout.trim().replace(/"/g,'')).split('|');
      send(res,200,{ok:true,
        branch: branch.stdout.trim(),
        last_commit:{hash:hash?.slice(0,8),subject,when,author},
        uncommitted_files: uncommitted,
        staged_files: staged,
        status_lines: lines.slice(0,50),
      });
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /git-commit  — stage all + commit  { message, add_all? }
  if(meth==='POST'&&path==='/git-commit'){
    const msg = String(b.message??b.msg??'').trim();
    if(!msg){send(res,400,{ok:false,error:'message required'});return;}
    const cwd = String(b.cwd??vscode.workspace.workspaceFolders?.[0]?.uri.fsPath??process.cwd());
    const addAll = b.add_all!==false;
    try{
      if(addAll) await runShellAndCapture('git add -A',cwd,10000);
      const r = await runShellAndCapture(`git commit -m "${msg.replace(/"/g,"'")}"`,cwd,15000);
      if(r.code!==0 && !r.stdout.includes('nothing to commit'))
        throw new Error(r.stderr||r.stdout);
      send(res,200,{ok:true,stdout:r.stdout.trim(),code:r.code});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /git-push  — push to remote  { remote?, branch? }
  if(meth==='POST'&&path==='/git-push'){
    const cwd = String(b.cwd??vscode.workspace.workspaceFolders?.[0]?.uri.fsPath??process.cwd());
    const remote = String(b.remote??'origin');
    const branch = String(b.branch??'');
    try{
      const cmd = branch ? `git push ${remote} ${branch}` : `git push ${remote}`;
      const r = await runShellAndCapture(cmd,cwd,30000);
      send(res,200,{ok:r.code===0,stdout:r.stdout.trim(),stderr:r.stderr.trim(),code:r.code});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  GET /git-diff  — unstaged diff (or staged with ?staged=1)
  if(meth==='GET'&&path==='/git-diff'){
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath??process.cwd();
    const staged = qp['staged']==='1'||qp['staged']==='true';
    try{
      const r = await runShellAndCapture(staged?'git diff --cached':'git diff',cwd,10000);
      send(res,200,{ok:true,diff:r.stdout.slice(0,50000),truncated:r.stdout.length>50000});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /search-workspace  — grep/regex search across workspace files
  //  Body: { pattern, path_glob?, max_results?, case_sensitive? }
  if(meth==='POST'&&path==='/search-workspace'){
    const pattern   = String(b.pattern??'').trim();
    if(!pattern){send(res,400,{ok:false,error:'pattern required'});return;}
    const root      = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath??process.cwd();
    const glob      = String(b.path_glob??'**/*');
    const maxRes    = Math.min(Number(b.max_results??200),1000);
    const cs        = b.case_sensitive===true;
    try{
      const files = await vscode.workspace.findFiles(glob,'**/{node_modules,.git,__pycache__}/**',5000);
      const re = new RegExp(pattern, cs?'g':'gi');
      const results:{file:string;line:number;text:string}[]=[];
      for(const f of files){
        if(results.length>=maxRes) break;
        try{
          const txt = fs.readFileSync(f.fsPath,'utf-8');
          txt.split('\n').forEach((ln,i)=>{ if(re.test(ln)&&results.length<maxRes) results.push({file:f.fsPath,line:i+1,text:ln.slice(0,200)}); re.lastIndex=0; });
        }catch{}
      }
      send(res,200,{ok:true,matches:results,total:results.length,truncated:results.length>=maxRes});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  GET /clipboard  — read current clipboard text
  if(meth==='GET'&&path==='/clipboard'){
    try{
      const text = await vscode.env.clipboard.readText();
      send(res,200,{ok:true,text,length:text.length});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /clipboard  — write text to clipboard  { text }
  if(meth==='POST'&&path==='/clipboard'){
    const text = String(b.text??b.content??'');
    try{
      await vscode.env.clipboard.writeText(text);
      send(res,200,{ok:true,length:text.length});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  GET /processes  — list running processes (name, pid, cpu, mem)
  if(meth==='GET'&&path==='/processes'){
    const filter = String(qp['filter']??'').toLowerCase();
    try{
      const r = await runShellAndCapture(
        'powershell -NoProfile -Command "Get-Process | Select-Object Name,Id,CPU,WorkingSet | ConvertTo-Json -Compress"',
        process.cwd(), 10000);
      let procs = JSON.parse(r.stdout.trim()) as {Name:string;Id:number;CPU:number;WorkingSet:number}[];
      if(filter) procs = procs.filter(p=>p.Name.toLowerCase().includes(filter));
      send(res,200,{ok:true,processes:procs.slice(0,200)});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /kill-process  — kill by name or PID  { name?, pid?, force? }
  if(meth==='POST'&&path==='/kill-process'){
    const name = String(b.name??'').trim();
    const pid  = Number(b.pid??0);
    const force= b.force!==false;
    if(!name&&!pid){send(res,400,{ok:false,error:'name or pid required'});return;}
    try{
      const cmd = pid
        ? `Stop-Process -Id ${pid} ${force?'-Force':''} -ErrorAction SilentlyContinue`
        : `Stop-Process -Name "${name}" ${force?'-Force':''} -ErrorAction SilentlyContinue`;
      const r = await runShellAndCapture(`powershell -NoProfile -Command "${cmd}"`,process.cwd(),10000);
      send(res,200,{ok:true,stdout:r.stdout.trim(),stderr:r.stderr.trim()});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /http-proxy  — make outbound HTTP/HTTPS request on behalf of agent
  //  Body: { url, method?, headers?, body? (string), timeout_ms? }
  if(meth==='POST'&&path==='/http-proxy'){
    const targetUrl = String(b.url??'').trim();
    if(!targetUrl){send(res,400,{ok:false,error:'url required'});return;}
    const targetMethod = String(b.method??'GET').toUpperCase();
    const targetHeaders = (b.headers as Record<string,string>)??{};
    const targetBody   = b.body ? String(b.body) : undefined;
    const tMs = Math.min(Number(b.timeout_ms??30000),120000);
    try{
      const u = new URL(targetUrl);
      const isHttps = u.protocol==='https:';
      const opts = {
        hostname: u.hostname,
        port: u.port||(isHttps?443:80),
        path: u.pathname+(u.search??''),
        method: targetMethod,
        headers: {'User-Agent':'AgentBridge/3.4',...targetHeaders,
          ...(targetBody?{'Content-Length':Buffer.byteLength(targetBody)}:{})},
      };
      const {status,body:rBody,hdrs} = await new Promise<{status:number;body:string;hdrs:Record<string,string>}>((resolve,reject)=>{
        const cb = (r2:http.IncomingMessage)=>{
          let d=''; r2.on('data',(c:Buffer)=>d+=c);
          r2.on('end',()=>resolve({status:r2.statusCode??0,body:d.slice(0,1_000_000),hdrs:r2.headers as Record<string,string>}));
        };
        const req2 = isHttps ? https.request(opts,cb) : http.request(opts,cb);
        req2.setTimeout(tMs,()=>{req2.destroy();reject(new Error('timeout'));});
        req2.on('error',reject);
        if(targetBody) req2.write(targetBody);
        req2.end();
      });
      send(res,200,{ok:true,status,body:rBody,headers:hdrs});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /format-file  — run VS Code formatter on a file  { path? }
  if(meth==='POST'&&path==='/format-file'){
    const fp = String(b.path??'').trim();
    try{
      const uri = fp ? vscode.Uri.file(fp) : vscode.window.activeTextEditor?.document.uri;
      if(!uri){send(res,400,{ok:false,error:'path required or open a file'});return;}
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('editor.action.formatDocument');
      await doc.save();
      send(res,200,{ok:true,path:uri.fsPath});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  GET /symbols  — code outline (functions, classes, vars) for a file
  if(meth==='GET'&&path==='/symbols'){
    const fp = String(qp['path']??'').trim();
    try{
      const uri = fp ? vscode.Uri.file(fp) : vscode.window.activeTextEditor?.document.uri;
      if(!uri){send(res,400,{ok:false,error:'path required or open a file'});return;}
      const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', uri);
      const flatten = (s:vscode.DocumentSymbol[],depth=0):object[]=>
        s.flatMap(x=>[{name:x.name,kind:vscode.SymbolKind[x.kind],line:x.range.start.line+1,depth},...flatten(x.children??[],depth+1)]);
      send(res,200,{ok:true,symbols:flatten(syms??[]),file:uri.fsPath});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /notify  — Windows toast notification  { message, title? }
  if(meth==='POST'&&path==='/notify'){
    const msg   = String(b.message??b.text??'').trim();
    const title = String(b.title??'Agent Bridge');
    if(!msg){send(res,400,{ok:false,error:'message required'});return;}
    const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null;`+
      `$t = [Windows.UI.Notifications.ToastTemplateType]::ToastText02;`+
      `$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($t);`+
      `$n = $x.GetElementsByTagName('text');`+
      `$n.Item(0).AppendChild($x.CreateTextNode('${title.replace(/'/g,'`\'')}')) | Out-Null;`+
      `$n.Item(1).AppendChild($x.CreateTextNode('${msg.replace(/'/g,'`\'')}')) | Out-Null;`+
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('AgentBridge').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
    exec(`powershell -NoProfile -Command "${ps.replace(/"/g,'\\"')}"`,()=>{});
    send(res,200,{ok:true,message:msg,title});
    return;
  }

  //  POST /schedule  — run a terminal command after a delay  { command, delay_ms, cwd? }
  if(meth==='POST'&&path==='/schedule'){
    const cmd     = String(b.command??'').trim();
    const delayMs = Math.min(Number(b.delay_ms??1000),3_600_000);
    if(!cmd){send(res,400,{ok:false,error:'command required'});return;}
    const cwd = String(b.cwd??vscode.workspace.workspaceFolders?.[0]?.uri.fsPath??process.cwd());
    const id  = `sched_${Date.now()}`;
    setTimeout(()=>{
      if(b.capture_output){
        runShellAndCapture(cmd,cwd,120000).catch(()=>{});
      } else {
        const t=vscode.window.createTerminal({name:`Scheduled-${id}`,cwd:vscode.Uri.file(cwd)});
        t.sendText(cmd); t.show();
      }
    }, delayMs);
    send(res,200,{ok:true,id,command:cmd,runs_in_ms:delayMs});
    return;
  }

  //  POST /rename-symbol  — rename a symbol across workspace  { old_name, new_name, path? }
  if(meth==='POST'&&path==='/rename-symbol'){
    const oldName = String(b.old_name??'').trim();
    const newName = String(b.new_name??'').trim();
    if(!oldName||!newName){send(res,400,{ok:false,error:'old_name and new_name required'});return;}
    try{
      const fp2 = String(b.path??'').trim();
      const uri = fp2 ? vscode.Uri.file(fp2) : vscode.window.activeTextEditor?.document.uri;
      if(!uri){send(res,400,{ok:false,error:'path required or open a file'});return;}
      const doc  = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      const idx  = text.indexOf(oldName);
      if(idx<0){send(res,400,{ok:false,error:`'${oldName}' not found in file`});return;}
      await vscode.window.showTextDocument(doc);
      const pos  = doc.positionAt(idx);
      await vscode.commands.executeCommand('editor.action.rename',uri,pos);
      send(res,200,{ok:true,note:`Rename dialog opened: ${oldName} → ${newName}. Type the new name and press Enter.`});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  GET /config  — read ~/.agent-bridge/config.json
  if(meth==='GET'&&path==='/config'){
    try{
      const cfgPath = np.join(os.homedir(),'.agent-bridge','config.json');
      const data = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath,'utf-8')) : {};
      // Redact sensitive keys before returning
      const safe = {...data};
      for(const k of ['slack_bot_token','auth_token','deepseek_api_key','openai_api_key']){
        if(safe[k]) safe[k]='***REDACTED***';
      }
      send(res,200,{ok:true,config:safe,path:cfgPath});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  //  POST /config  — update a key in ~/.agent-bridge/config.json  { key, value }
  if(meth==='POST'&&path==='/config'){
    const key   = String(b.key??'').trim();
    const value = b.value;
    if(!key){send(res,400,{ok:false,error:'key required'});return;}
    // Block writing credentials via API for security
    const blocked=['slack_bot_token','auth_token','deepseek_api_key','openai_api_key'];
    if(blocked.includes(key)){send(res,403,{ok:false,error:`'${key}' is write-protected — edit ~/.agent-bridge/config.json manually`});return;}
    try{
      const cfgPath = np.join(os.homedir(),'.agent-bridge','config.json');
      const dir = np.dirname(cfgPath);
      if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
      const data = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath,'utf-8')) : {};
      data[key] = value;
      fs.writeFileSync(cfgPath,JSON.stringify(data,null,2),'utf-8');
      send(res,200,{ok:true,key,note:'config updated'});
    }catch(e){send(res,500,{ok:false,error:String(e)});}
    return;
  }

  send(res,404,{ok:false,error:`Unknown: ${meth} ${path}`});
}

//  server lifecycle 
const startSrv = (p:number):Promise<void> => new Promise((ok,fail)=>{
  srv = http.createServer((req,res)=>{
    route(req,res).catch(e=>send(res,500,{ok:false,error:String(e)}));
  });
  srv.on('error',(e:NodeJS.ErrnoException)=>{
    if(e.code==='EADDRINUSE') startSrv(p+1).then(ok).catch(fail);
    else fail(e);
  });
  srv.listen(p,'127.0.0.1',()=>{ port=p; updateBar(true); ok(); });
});

const stopSrv = () => { if(srv){srv.close();srv=null;} };

function updateBar(up:boolean){
  if(up){
    bar.text=`$(broadcast) Bridge :${port}`;
    bar.tooltip=`Agent Bridge v3 on :${port}  ${'Copilot ready'}`;
    bar.backgroundColor=undefined;
    bar.color=new vscode.ThemeColor('statusBarItem.prominentForeground');
  }else{
    bar.text=`$(error) Bridge DOWN`;
    bar.backgroundColor=new vscode.ThemeColor('statusBarItem.errorBackground');
  }
}

//  webview panel 
function openPanel(ctx:vscode.ExtensionContext){
  if(logPanel){logPanel.reveal();return;}
  logPanel=vscode.window.createWebviewPanel('agentBridge','Agent Bridge',vscode.ViewColumn.Two,{enableScripts:true});
  logPanel.webview.html=`<!DOCTYPE html><html><head><style>
    body{background:#1e1e1e;color:#ccc;font:12px monospace;margin:0;padding:10px;}
    #log{white-space:pre-wrap;word-break:break-all;}
    h2{color:#4ec9b0;}
    .ok{color:#4fc1ff} .err{color:#f44747}
  </style></head><body>
  <h2> Agent Bridge v3  port ${port}</h2>
  <div id="log">${logEntries.join('\n')}</div>
  <script>
    const vsc=acquireVsCodeApi();
    window.addEventListener('message',e=>{
      const d=document.getElementById('log');
      d.textContent+='\n'+e.data.line;
      d.scrollTop=d.scrollHeight;
    });
  </script></body></html>`;
  logPanel.onDidDispose(()=>{logPanel=null;},null,ctx.subscriptions);
}

//  activate 
export async function activate(ctx:vscode.ExtensionContext){
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e=>regChange(e.document.uri)),
    vscode.workspace.onDidSaveTextDocument(d=>regChange(d.uri)),
    vscode.workspace.onDidCreateFiles(e=>e.files.forEach(regChange)),
  );

  bar=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,200);
  bar.command='agentBridge.panel';
  bar.show();
  ctx.subscriptions.push(bar);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.panel',()=>openPanel(ctx)),
    vscode.commands.registerCommand('agentBridge.restart',async()=>{
      stopSrv();
      await startSrv(PORT_START);
      vscode.window.showInformationMessage(`Agent Bridge restarted on :${port}`);
    }),
  );

  try{
    await startSrv(PORT_START);
    const models=await vscode.lm.selectChatModels({vendor:'copilot'});
    log('STARTUP',`/health`,{},{port,models:models.length});
    vscode.window.showInformationMessage(` Agent Bridge v3 on :${port}  ${models.length} models ready`);
  }catch(e){
    vscode.window.showErrorMessage(`Agent Bridge failed: ${e}`);
    updateBar(false);
  }
}

export function deactivate(){ stopSrv(); }

