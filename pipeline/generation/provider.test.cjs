const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexProvider } = require('./provider.cjs');

function temporary(t) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'shorts-provider-test-'));
  t.after(() => {
    if (!root.startsWith(parent + path.sep)) throw new Error('Unsafe temporary cleanup path.');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function fake(root, code) {
  const file = path.join(root, 'fake-codex.cjs');
  fs.writeFileSync(file, `const fs=require('node:fs'); const args=process.argv.slice(2); const output=args[args.indexOf('--output-last-message')+1]; let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>prompt+=c); process.stdin.on('end',()=>{${code}});`);
  return file;
}

function input(root) {
  return { prompt: 'Return Korean text: 안녕하세요.', schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, directory: path.join(root, 'attempt') };
}

test('provider uses stdin and structured read-only Codex invocation, keeps usage and answer', async t => {
  const root = temporary(t);
  const executable = fake(root, `fs.writeFileSync(output,JSON.stringify({text:prompt,args})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:8,secret:'not persisted'}}));`);
  const request = input(root);
  const result = await createCodexProvider({ executable, model: 'test-model' })(request);
  assert.equal(result.text, request.prompt);
  assert.deepEqual(result.args.slice(0, 3), ['-a', 'never', 'exec']);
  assert.equal(result.args[result.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(result.args.includes('--ephemeral'));
  assert.ok(result.args.includes('--ignore-user-config'));
  assert.ok(result.args.includes('web_search="disabled"'));
  assert.ok(!result.args.includes(request.prompt));
  assert.equal(result.args.at(-1), '-');
  const metadata = JSON.parse(fs.readFileSync(path.join(request.directory, 'provider.json')));
  assert.equal(metadata.status, 'succeeded');
  assert.deepEqual(metadata.usage, { input_tokens: 10, output_tokens: 8 });
  assert.equal(fs.readFileSync(path.join(request.directory, 'prompt.txt'), 'utf8'), request.prompt);
  await assert.rejects(createCodexProvider({ executable })(request), /already contains provider artifacts/);
});

test('provider rejects nonzero exit and redacts diagnostics from persisted metadata', async t => {
  const root = temporary(t);
  const executable = fake(root, `fs.writeFileSync(output,'{"text":"should not be accepted"}'); console.error('401 unauthorized Bearer pretend-secret'); process.exitCode=2;`);
  const request = input(root);
  await assert.rejects(createCodexProvider({ executable })(request), /authentication; exit 2/);
  const metadata = fs.readFileSync(path.join(request.directory, 'provider.json'), 'utf8');
  assert.ok(!metadata.includes('pretend-secret'));
  assert.equal(JSON.parse(metadata).status, 'failed');
});

test('provider rejects missing, invalid, and non-object JSON answers', async t => {
  for (const [name, code, expected] of [
    ['missing', '', /without an answer/],
    ['invalid', `fs.writeFileSync(output,'not JSON');`, /not valid JSON/],
    ['array', `fs.writeFileSync(output,'[]');`, /JSON object/],
  ]) {
    await t.test(name, async subtest => {
      const root = temporary(subtest);
      const executable = fake(root, code);
      await assert.rejects(createCodexProvider({ executable })(input(root)), expected);
    });
  }
});

test('provider identifies local sandbox permission errors and JSON error events', async t => {
  for (const [name, code, category] of [
    ['permissions', `console.error('failed to initialize app-server: 액세스가 거부되었습니다. (os error 5)'); process.exitCode=1;`, 'permissions'],
    ['json-error', `console.log(JSON.stringify({type:'turn.failed',error:{message:'network stream disconnected'}})); process.exitCode=1;`, 'network'],
  ]) {
    await t.test(name, async subtest => {
      const root = temporary(subtest);
      const executable = fake(root, code);
      const request = input(root);
      await assert.rejects(createCodexProvider({ executable })(request), new RegExp(category));
      const metadata = JSON.parse(fs.readFileSync(path.join(request.directory, 'provider.json')));
      assert.equal(metadata.errorCategory, category);
      assert.ok(metadata.diagnostic);
    });
  }
});

test('provider times out and stops the launched process', async t => {
  const root = temporary(t);
  const executable = fake(root, `setInterval(()=>{},1000);`);
  const request = input(root);
  const started = Date.now();
  await assert.rejects(createCodexProvider({ executable, timeoutMs: 500 })(request), /timed out/);
  assert.ok(Date.now() - started < 7000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(request.directory, 'provider.json'))).errorCategory, 'timeout');
});

test('provider rejects a tool call instead of accepting agent side effects as generation', async t => {
  const root = temporary(t);
  const executable = fake(root, `console.log(JSON.stringify({type:'item.started',item:{type:'command_execution'}})); setInterval(()=>{},1000);`);
  await assert.rejects(createCodexProvider({ executable })(input(root)), /attempted a tool action/);
});

test('provider validates options and handles missing executable without shell fallback', async t => {
  const root = temporary(t);
  assert.throws(() => createCodexProvider({ timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => createCodexProvider({ model: 'bad model; command' }), /model name/);
  await assert.rejects(createCodexProvider({ executable: path.join(root, 'missing.exe') })(input(root)), /existing executable/);
});
