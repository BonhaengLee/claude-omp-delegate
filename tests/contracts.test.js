import test from 'node:test';
import assert from 'node:assert/strict';
import {briefSchema,toolSchemas,parseRunOptions,resolveModel,parseBriefOptions,jobSchema} from '../src/contracts.js';
const brief={goal:'Implement clamp',decisions:'Throw on invalid range',writeScope:['clamp.js'],acceptance:['Bounds'],constraints:['Preserve dirty files'],verification:['node clamp.js']};
test('reject incomplete brief and unknown mutating input',()=>{
 assert.throws(()=>briefSchema.parse({...brief,acceptance:[]}));
 assert.throws(()=>toolSchemas.omp_start.parse({workspace:'relative',brief}));
 assert.throws(()=>toolSchemas.omp_start.parse({workspace:'/tmp',brief,model:'unrecognized'}));
});
test('exact Codex selector and thinking levels, no shell interpretation',()=>{
 assert.deepEqual(parseRunOptions(['--model','openai-codex/gpt-6-astra','--thinking','high','한글 $(touch nope)']),{model:'openai-codex/gpt-6-astra',thinking:'high',text:'한글 $(touch nope)'});
 for(const model of ['gpt-6-astra','anthropic/opus','openai-codex/gpt*','openai-codex/gpt:high'])assert.throws(()=>parseRunOptions(['--model',model]));
 assert.throws(()=>parseRunOptions(['--thinking','unlimited']));
 assert.throws(()=>parseRunOptions(['--model']));
});

test('pins Codex through role aliases and rejects cycles or provider changes',()=>{
 assert.deepEqual(resolveModel({default:'@task',task:'openai-codex/gpt-6-astra:medium'}),{model:'openai-codex/gpt-6-astra',thinking:'medium'});
 assert.deepEqual(resolveModel({default:'openai-codex/gpt-6-astra:medium'},'@default','high'),{model:'openai-codex/gpt-6-astra',thinking:'high'});
 assert.throws(()=>resolveModel({default:'@task',task:'@default'}),{code:'MODEL_NOT_CODEX'});
 assert.throws(()=>resolveModel({default:'anthropic/opus'}),{code:'MODEL_NOT_CODEX'});
 assert.throws(()=>resolveModel({default:'@missing'}),{code:'MODEL_NOT_CODEX'});
});

test('job boundary parses leading flags without shell evaluation or goal contamination',()=>{
 const request=parseBriefOptions({...brief,goal:'--model openai-codex/gpt-6-astra --thinking high 한글 $(touch never) "literal"'});
 assert.equal(request.model,'openai-codex/gpt-6-astra');assert.equal(request.thinking,'high');assert.equal(request.goal,'한글 $(touch never) "literal"');
 for(const goal of ['--unknown x actual','--model','--thinking low --thinking high goal'])assert.throws(()=>parseBriefOptions({...brief,goal}),{code:'INVALID_INPUT'});
 assert.throws(()=>parseBriefOptions({...brief,model:'openai-codex/one',goal:'--model openai-codex/two goal'}),{code:'INVALID_INPUT'});
 assert.equal(parseBriefOptions({...brief,goal:'Document literal --thinking high'}).goal,'Document literal --thinking high');
});

test('persisted jobs cannot bypass the Codex selector and thinking contract',()=>{
 const job={version:1,id:'11111111-1111-4111-8111-111111111111',workspace:'/tmp',lockKey:'/tmp',status:'starting',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),sessionDir:'/tmp/sessions',executable:'/usr/bin/omp',modelRequested:'openai-codex/valid',workerNonce:'22222222-2222-4222-8222-222222222222',warnings:[]};
 for(const mutation of [{modelRequested:'other-provider/model'},{modelRequested:'@default'},{modelActual:'other-provider/model'},{thinking:'invented-level'}])assert.equal(jobSchema.safeParse({...job,...mutation}).success,false);
});
