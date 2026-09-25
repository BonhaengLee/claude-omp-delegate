import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,chmod} from 'node:fs/promises';import {spawnSync} from 'node:child_process';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {startJob,waitForJob} from '../src/jobs.js';
const fixture=fileURLToPath(new URL('./fixtures/job-omp.mjs',import.meta.url));
function git(cwd,...args){const r=spawnSync('git',args,{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;}
test('preserved dirty and untracked files are baseline, not worker change warnings',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'omp-evidence-')));const workspace=path.join(root,'workspace');const state=path.join(root,'state');const previous=process.env.OMP_DELEGATE_STATE_DIR;let cleanupSafe=false;
 try{
  await mkdir(workspace,{mode:0o700});await mkdir(state,{mode:0o700});await chmod(fixture,0o755);await writeFile(path.join(state,'config.json'),JSON.stringify({version:1,executable:fixture}),{mode:0o600});
  git(workspace,'init','--quiet');await writeFile(path.join(workspace,'sentinel.txt'),'committed');git(workspace,'add','sentinel.txt');git(workspace,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture baseline');await writeFile(path.join(workspace,'sentinel.txt'),'USER DIRTY');await writeFile(path.join(workspace,'untracked.txt'),'USER UNTRACKED');
  process.env.OMP_DELEGATE_STATE_DIR=state;
  const created=await startJob({workspace,brief:{goal:'JOB_FIXTURE_MODE=success',decisions:'No writes',writeScope:['allowed.txt'],acceptance:['Preserve user changes'],constraints:['Do not modify user files'],verification:['Compare actual before and after contents']}});
  const done=await waitForJob({workspace,jobId:created.id,timeoutMs:10000});assert.equal(done.status,'completed',JSON.stringify(done));cleanupSafe=true;
  assert.equal(await readFile(path.join(workspace,'sentinel.txt'),'utf8'),'USER DIRTY');assert.equal(await readFile(path.join(workspace,'untracked.txt'),'utf8'),'USER UNTRACKED');
  assert.equal(done.warnings.some(x=>/outside writeScope/i.test(x)),false,JSON.stringify(done.warnings));
 }finally{if(previous===undefined)delete process.env.OMP_DELEGATE_STATE_DIR;else process.env.OMP_DELEGATE_STATE_DIR=previous;if(cleanupSafe)await rm(root,{recursive:true,force:true});else console.error('Preserving failed fixture state: '+root);}
});
