// Agent workflow: dry-run first. --write requires the user's explicit approval of ALL marked writing.
// This script records confirmation; it cannot determine whether approval was actually given.
const fs = require('node:fs');
const path = require('node:path');
const MARKER = '[' + 'NEEDS WRITING PASS' + ']';

function changes(root) {
  const found=[];
  function scan(dir) {
    if(!fs.existsSync(path.join(root,dir))) return;
    for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})) {
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink()) continue;
      if(entry.isDirectory()) {scan(file);continue;}
      // Generated catalogue is rebuilt, never edited. Keep policy, tests and docs intact.
      if(file==='source/text-catalogue.js' || file==='scripts/clear-writing-pass.cjs' || !/\.(js|cjs|mjs|tw|twee|svg|css|json|py)$/.test(file)) continue;
      const before=fs.readFileSync(path.join(root,file),'utf8');
      const count=before.split(MARKER).length-1;
      if(!count) continue;
      // Horizontal whitespace only: preserve CRLF, line layout and adjacent prose.
      const after=before.replace(/\[NEEDS WRITING PASS\](?:[ \t]*[—–-][ \t]*|[ \t]+)?/g,'');
      found.push({file,count,before,after});
    }
  }
  scan('source');scan('scripts');return found;
}

function run(args,root=path.resolve(__dirname,'..'),log=console.log) {
  const write=args.includes('--write'), approvalIndex=args.indexOf('--user-approved');
  const approval=approvalIndex>=0?args[approvalIndex+1]:'';
  const known=args.filter((_,i)=>i!==approvalIndex+1 || approvalIndex<0);
  if(known.some(arg=>!['--write','--user-approved','--dry-run'].includes(arg)) || (write && args.includes('--dry-run'))) throw Error('Usage: node scripts/clear-writing-pass.cjs [--dry-run | --write --user-approved "approval reference"]');
  if(write && (!approval || approval.startsWith('--') || !approval.trim())) throw Error('Refusing to clear tags without --user-approved "reference to explicit user approval of ALL marked writing".');
  const edits=changes(root);
  for(const edit of edits) log(`${edit.file}: ${edit.count} tag(s)`);
  log(`${write?'Clearing':'Dry run:'} ${edits.reduce((n,e)=>n+e.count,0)} tag(s) in ${edits.length} file(s).`);
  if(!write) {log('No files changed. Only use --write --user-approved "approval reference" after the user approves ALL marked writing.');return edits;}
  // Check every file before any write, so a concurrent edit causes a clean refusal.
  for(const edit of edits) if(fs.readFileSync(path.join(root,edit.file),'utf8')!==edit.before) throw Error('Source changed during review: '+edit.file);
  for(const edit of edits) fs.writeFileSync(path.join(root,edit.file),edit.after);
  log('Approval reference: '+approval);
  log('Review git diff, regenerate any affected art/data assets, run npm run build and focused tests, then deploy and commit. Do not clear future tags automatically.');
  return edits;
}
if(require.main===module) {
  try {run(process.argv.slice(2));} catch(error) {console.error(error.message);process.exitCode=1;}
}
module.exports={changes,run};
