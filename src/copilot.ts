import * as vscode from 'vscode';
import { readText } from './helpers';

export const PREFER_ORDER = [
  'claude-sonnet-4-5', 'claude-sonnet-4', 'gpt-4.1', 'gpt-4o',
  'gpt-5', 'claude-opus-4', 'gpt-4', 'gpt-3.5-turbo',
];

export const ACCEPT = [
  'workbench.action.chat.acceptAllCopilotEdits',
  'inlineChat.acceptChanges',
  'editor.action.inlineSuggest.accept',
  'copilot.chat.acceptEdits',
];
export const REJECT = [
  'workbench.action.chat.discardAllCopilotEdits',
  'inlineChat.discard',
  'editor.action.inlineSuggest.hide',
];
export const DISMISS = [
  'workbench.action.closeMessages',
  'notifications.clearAll',
  'editor.action.inlineSuggest.accept',
  'workbench.action.acceptSelectedQuickOpenItem',
];
export const KEEP_GOING_CMDS = [...ACCEPT, ...DISMISS, 'workbench.action.closeNotification'];

export const tryCmds = async (cmds: string[]) => {
  const ran: string[] = [];
  for (const c of cmds) { try { await vscode.commands.executeCommand(c); ran.push(c); } catch {} }
  return ran;
};

/** Call GitHub Copilot with a prompt. Returns text + model name used. */
export async function callCopilot(
  prompt: string,
  system?: string,
  pref?: string,
  ms = 300_000,
): Promise<{ text: string; model_used: string }> {
  const order = pref ? [pref, ...PREFER_ORDER] : PREFER_ORDER;
  let model: vscode.LanguageModelChat | undefined;
  for (const f of order) {
    const c = await vscode.lm.selectChatModels({ vendor: 'copilot', family: f });
    if (c.length) { model = c[0]; break; }
  }
  if (!model) {
    const all = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!all.length) throw new Error('No Copilot model — sign in to GitHub Copilot');
    model = all[0];
  }
  const msgs: vscode.LanguageModelChatMessage[] = [];
  if (system) msgs.push(vscode.LanguageModelChatMessage.Assistant(system));
  msgs.push(vscode.LanguageModelChatMessage.User(prompt));
  const cts = new vscode.CancellationTokenSource();
  const t = setTimeout(() => cts.cancel(), ms);
  try {
    const r = await model.sendRequest(msgs, {}, cts.token);
    let text = '';
    for await (const c of r.text) text += c;
    return { text, model_used: model.name };
  } finally { clearTimeout(t); cts.dispose(); }
}

/** Inject context files into a prompt string. */
export async function buildPromptWithContext(
  prompt: string,
  ctxPaths: string[],
  activeFileContext?: boolean,
): Promise<string> {
  if (activeFileContext && vscode.window.activeTextEditor)
    ctxPaths = [vscode.window.activeTextEditor.document.uri.fsPath, ...ctxPaths];
  if (!ctxPaths.length) return prompt;
  const blocks: string[] = [];
  for (const cf of ctxPaths.slice(0, 8)) {
    try {
      const txt = await readText(cf);
      blocks.push(`FILE: ${cf}\n\`\`\`\n${txt.slice(0, 12_000)}\n\`\`\``);
    } catch { blocks.push(`FILE: ${cf}\n[could not read]`); }
  }
  return blocks.join('\n\n') + '\n\n---\n' + prompt;
}

/** Apply a precise find-and-replace edit to a VS Code document. */
export async function applyEdit(path: string, oldText: string, newText: string) {
  const uri  = vscode.Uri.file(path);
  const doc  = await vscode.workspace.openTextDocument(uri);
  const full = doc.getText();
  const idx  = full.indexOf(oldText);
  if (idx < 0) throw new Error(`old_text not found in ${path}`);
  const edit  = new vscode.WorkspaceEdit();
  const start = doc.positionAt(idx);
  const end   = doc.positionAt(idx + oldText.length);
  edit.replace(uri, new vscode.Range(start, end), newText);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
}
