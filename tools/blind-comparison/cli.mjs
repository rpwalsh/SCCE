#!/usr/bin/env node
import { argsMap, required } from '../sealed-eval/harness/lib/util.mjs';
import { freeze, seal } from './protocol.mjs';
import { collect, checkpoint } from './runner.mjs';
import { blind, grade } from './grading.mjs';
import { smoke } from './smoke.mjs';
const command = process.argv[2], args = argsMap(process.argv.slice(3));
const val = key => required(args, key);
const common = () => ({ bundleFile: val('bundle'), bundleDigest: val('bundle-digest'), out: val('out') });
const custody = () => ({ ...common(), keyFile: val('key'), checkpointFile: val('checkpoint'), checkpointDigest: val('checkpoint-digest') });
try {
  let result;
  if (command === 'freeze') result = await freeze(val('plan'), val('out'));
  else if (command === 'seal') result = await seal({ freezeFile: val('freeze'), freezeDigest: val('freeze-digest'), poolFile: val('pool'), seedFile: val('seed'), outDir: val('out') });
  else if (command === 'collect') {
    const options = { ...common(), shardIndex: Number(args.get('shard-index') ?? 0), shardCount: Number(args.get('shard-count') ?? 1) };
    result = await collect(options);
    if (args.has('checkpoint-out')) result.checkpoint = await checkpoint({ ...options, checkpointFile: val('checkpoint-out') });
  }
  else if (command === 'checkpoint') result = await checkpoint({ ...common(), checkpointFile: val('checkpoint-out') });
  else if (command === 'blind') result = await blind({ ...custody(), ballotsDir: val('ballots') });
  else if (command === 'grade') result = await grade({ ...custody(), ratingsFile: args.get('ratings'), ratingsDigest: args.get('ratings-digest'), reportFile: val('report') });
  else if (command === 'smoke') result = await smoke(val('out'));
  else throw new Error('Commands: freeze, seal, collect, checkpoint, blind, grade, smoke');
  console.log(JSON.stringify(result, null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
